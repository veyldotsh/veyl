// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {RevenueRouter} from "../Funding.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ILaunchProtection {
    function validateLaunchSwap() external view;
}

interface IQuoteRevenue {
    function deposit(uint256 amount) external;
    function quoteAsset() external view returns (address);
}

/// @notice Immutable quote-currency fee collection for one native-ETH/token or VEYL/agent v4 pool.
/// @dev Rates are deployment inputs, not finalized product economics. No exemptions or fee setters.
/// Exact-input buys and exact-output sells must fill completely or revert. Their quote fee is
/// specified before execution; reverting partial fills avoids charging on unspent input.
/// The opposite modes charge actual executed quote currency. Hook fees are separate from the LP fee.
contract VeylFeeHook is IHooks, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant BPS = 10_000;
    IPoolManager public immutable poolManager;
    address public immutable token;
    address public immutable quoteAsset;
    bool public immutable tokenIsCurrency0;
    uint256 public immutable quoteCurrencyId;
    RevenueRouter public immutable revenueRouter;
    address public immutable initializer;
    uint16 public immutable buyFeeBps;
    uint16 public immutable sellFeeBps;
    uint24 public immutable lpFee;
    int24 public immutable tickSpacing;
    PoolId public immutable poolId;
    bool public poolInitialized;
    uint256 private redeeming;

    error InvalidConfiguration();
    error NotPoolManager();
    error WrongPool();
    error NotInitializer();
    error AlreadyInitialized();
    error SwapTooLarge();
    error PartialFillUnsupported();
    error InvalidSwapDelta();
    error NoRedemption();
    error TransferFailed();
    error HookNotImplemented();

    event FeeAccrued(bool indexed isBuy, uint256 quoteFee);
    event FeesFlushed(address indexed caller, uint256 quoteAmount);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(
        IPoolManager manager_,
        address token_,
        RevenueRouter router_,
        address initializer_,
        uint16 buyBps_,
        uint16 sellBps_,
        uint24 lpFee_,
        int24 tickSpacing_,
        address quoteAsset_
    ) {
        if (
            address(manager_).code.length == 0 || token_.code.length == 0 || address(router_).code.length == 0
                || initializer_ == address(0) || buyBps_ >= BPS || sellBps_ >= BPS || lpFee_ >= 1_000_000
                || tickSpacing_ <= 0 || tickSpacing_ > 32_767 || quoteAsset_ == token_
                || (quoteAsset_ != address(0) && quoteAsset_.code.length == 0)
        ) revert InvalidConfiguration();
        if (
            router_.treasuryBps() != 7_000 || router_.creatorBps() != 2_000 || router_.protocolBps() != 1_000
                || router_.treasury() == address(0) || router_.creator() == address(0)
                || router_.protocol() == address(0)
        ) {
            revert InvalidConfiguration();
        }
        poolManager = manager_;
        token = token_;
        quoteAsset = quoteAsset_;
        tokenIsCurrency0 = token_ < quoteAsset_;
        quoteCurrencyId = uint256(uint160(quoteAsset_));
        if (quoteAsset_ != address(0) && IQuoteRevenue(address(router_)).quoteAsset() != quoteAsset_) {
            revert InvalidConfiguration();
        }
        revenueRouter = router_;
        initializer = initializer_;
        buyFeeBps = buyBps_;
        sellFeeBps = sellBps_;
        lpFee = lpFee_;
        tickSpacing = tickSpacing_;
        poolId = PoolIdLibrary.toId(_key(token_, lpFee_, tickSpacing_));
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
        permissions.beforeSwapReturnDelta = true;
        permissions.afterSwapReturnDelta = true;
    }

    function getPoolKey() external view returns (PoolKey memory) {
        return _key(token, lpFee, tickSpacing);
    }

    function _key(address token_, uint24 fee_, int24 spacing_) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(token_ < quoteAsset ? token_ : quoteAsset),
            currency1: Currency.wrap(token_ < quoteAsset ? quoteAsset : token_),
            fee: fee_,
            tickSpacing: spacing_,
            hooks: IHooks(address(this))
        });
    }

    function _checkPool(PoolKey calldata key) private view {
        if (PoolId.unwrap(PoolIdLibrary.toId(key)) != PoolId.unwrap(poolId)) revert WrongPool();
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external onlyPoolManager returns (bytes4) {
        _checkPool(key);
        if (sender != initializer) revert NotInitializer();
        if (poolInitialized) revert AlreadyInitialized();
        poolInitialized = true;
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _checkPool(key);
        if (!poolInitialized) revert WrongPool();
        ILaunchProtection(token).validateLaunchSwap();
        if (
            params.amountSpecified == 0 || params.amountSpecified < -int256(type(int128).max)
                || params.amountSpecified > int256(type(int128).max)
        ) revert SwapTooLarge();
        uint256 fee;
        bool buy = params.zeroForOne != tokenIsCurrency0;
        if (buy && params.amountSpecified < 0) {
            fee = uint256(-params.amountSpecified) * buyFeeBps / BPS;
        } else if (!buy && params.amountSpecified > 0) {
            fee = _grossUp(uint256(params.amountSpecified), sellFeeBps);
            if (uint256(params.amountSpecified) + fee > uint256(uint128(type(int128).max))) revert SwapTooLarge();
        }
        if (fee > 0) poolManager.mint(address(this), quoteCurrencyId, fee);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(_asInt128(fee), 0), 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        _checkPool(key);
        uint256 fee;
        bool buy = params.zeroForOne != tokenIsCurrency0;
        bool specifiedQuote = (params.amountSpecified < 0) == buy;
        int128 quoteDelta = tokenIsCurrency0 ? delta.amount1() : delta.amount0();
        if (buy) {
            if (quoteDelta > 0) revert InvalidSwapDelta();
            uint256 quoteIn = uint256(-int256(quoteDelta));
            if (specifiedQuote) {
                uint256 total = uint256(-params.amountSpecified);
                fee = total * buyFeeBps / BPS;
                if (quoteIn != total - fee) revert PartialFillUnsupported();
            } else {
                // Gross up so the rate is a fraction of total quote paid, including this fee.
                fee = _grossUp(quoteIn, buyFeeBps);
                if (quoteIn + fee > uint256(uint128(type(int128).max))) revert SwapTooLarge();
            }
        } else {
            if (quoteDelta < 0) revert InvalidSwapDelta();
            uint256 quoteOut = uint256(uint128(quoteDelta));
            if (specifiedQuote) {
                uint256 net = uint256(params.amountSpecified);
                fee = _grossUp(net, sellFeeBps);
                if (quoteOut != net + fee) revert PartialFillUnsupported();
            } else {
                fee = quoteOut * sellFeeBps / BPS;
            }
        }
        if (!specifiedQuote && fee > 0) poolManager.mint(address(this), quoteCurrencyId, fee);
        emit FeeAccrued(buy, fee);
        return (IHooks.afterSwap.selector, specifiedQuote ? int128(0) : _asInt128(fee));
    }

    function _grossUp(uint256 net, uint16 rate) private pure returns (uint256) {
        uint256 denominator = BPS - rate;
        return (net * rate + denominator - 1) / denominator;
    }

    function _asInt128(uint256 value) private pure returns (int128) {
        if (value > uint256(uint128(type(int128).max))) revert SwapTooLarge();
        return int128(uint128(value));
    }

    function pendingFees() public view returns (uint256) {
        return poolManager.balanceOf(address(this), quoteCurrencyId);
    }

    /// @notice Redeems quote claims. Native revenue splits now; VEYL waits for bounded ETH conversion.
    /// Anyone may flush; beneficiaries claim independently from the router afterwards.
    function flushFees() external nonReentrant returns (uint256 amount) {
        amount = pendingFees();
        if (amount == 0) return 0;
        redeeming = amount;
        poolManager.unlock("");
        redeeming = 0;
        if (quoteAsset == address(0)) {
            (bool ok,) = address(revenueRouter).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20 quote = IERC20(quoteAsset);
            uint256 beforeBalance = quote.balanceOf(address(this));
            quote.forceApprove(address(revenueRouter), amount);
            IQuoteRevenue(address(revenueRouter)).deposit(amount);
            quote.forceApprove(address(revenueRouter), 0);
            if (quote.balanceOf(address(this)) + amount != beforeBalance) revert TransferFailed();
        }
        emit FeesFlushed(msg.sender, amount);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        uint256 amount = redeeming;
        if (amount == 0 || data.length != 0) revert NoRedemption();
        poolManager.burn(address(this), quoteCurrencyId, amount);
        uint256 beforeBalance =
            quoteAsset == address(0) ? address(this).balance : IERC20(quoteAsset).balanceOf(address(this));
        poolManager.take(Currency.wrap(quoteAsset), address(this), amount);
        uint256 afterBalance =
            quoteAsset == address(0) ? address(this).balance : IERC20(quoteAsset).balanceOf(address(this));
        if (afterBalance != beforeBalance + amount) revert TransferFailed();
        return "";
    }

    receive() external payable {
        if (msg.sender != address(poolManager) || redeeming == 0) revert NoRedemption();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
