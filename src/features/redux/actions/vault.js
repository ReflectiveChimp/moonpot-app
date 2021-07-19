import {HOME_FETCH_POOLS_BEGIN, HOME_FETCH_POOLS_DONE} from "../constants";
import BigNumber from "bignumber.js";
import {MultiCall} from "eth-multicall";
import {config} from "../../../config/config";
import {isEmpty} from "../../../helpers/utils";
const gateManagerAbi = require('../../../config/abi/gatemanager.json');
const ecr20Abi = require('../../../config/abi/erc20.json');
const prizeStrategyAbi = require('../../../config/abi/prizestrategy.json');

const getPoolsSingle = async (item, state, dispatch) => {
    console.log('redux getPoolsSingle() processing...');
    const web3 = state.walletReducer.rpc;
    const pools = state.vaultReducer.pools;
    const prices = state.pricesReducer.prices;
    const apy = state.pricesReducer.apy;

    const gateContract = new web3[item.network].eth.Contract(gateManagerAbi, item.contractAddress);
    const awardQuery =  await gateContract.methods.awardBalance().call();
    const awardPrice = (pools[item.id].oracleId in prices) ? prices[pools[item.id].oracleId] : 0;
    const awardBalance = new BigNumber(awardQuery).dividedBy(new BigNumber(10).exponentiatedBy(pools[item.id].tokenDecimals));

    const strategyContract = new web3[item.network].eth.Contract(prizeStrategyAbi, item.prizeStrategyAddress);
    const expiresAt = await strategyContract.methods.prizePeriodEndAt().call();


    pools[item.id].awardBalance = awardBalance;
    pools[item.id].awardBalanceUsd = awardBalance.times(new BigNumber(awardPrice));
    pools[item.id].sponsorBalance = new BigNumber(0);
    pools[item.id].sponsorBalanceUsd = new BigNumber(0);
    pools[item.id].apy = (!isEmpty(apy) && pools[item.id].apyId in apy) ? (new BigNumber(apy[pools[item.id].apyId].totalApy).times(100).div(2).toFixed(2)) : 0;
    pools[item.id].bonusApy = 0;
    pools[item.id].expiresAt = expiresAt;

    if(!isEmpty(item.sponsorAddress)) {
        const sponsorContract = new web3[item.network].eth.Contract(ecr20Abi, item.sponsorAddress);
        const sponsorQuery = await sponsorContract.methods.balanceOf(item.prizePoolAddress).call();
        const sponsorPrice = (pools[item.id].sponsorToken in prices) ? prices[pools[item.id].sponsorToken] : 0;
        const sponsorBalance = new BigNumber(sponsorQuery).dividedBy(new BigNumber(10).exponentiatedBy(pools[item.id].sponsorTokenDecimals));

        const rewardRate = new BigNumber(await gateContract.methods.rewardRate().call());
        const TotalValueLocked = new BigNumber(await gateContract.methods.TVL().call());
        const totalStakedUsd = TotalValueLocked.times(awardPrice).dividedBy(new BigNumber(10).exponentiatedBy(pools[item.id].sponsorTokenDecimals));
        const yearlyRewards = rewardRate.times(3600).times(24).times(365);
        const yearlyRewardsInUsd = yearlyRewards.times(sponsorPrice).dividedBy(new BigNumber(10).exponentiatedBy(pools[item.id].sponsorTokenDecimals))

        pools[item.id].sponsorBalance = sponsorBalance;
        pools[item.id].sponsorBalanceUsd = sponsorBalance.times(sponsorPrice);
        pools[item.id].bonusApy = Number(yearlyRewardsInUsd.dividedBy(totalStakedUsd));
    }

    dispatch({
        type: HOME_FETCH_POOLS_DONE,
        payload: {
            pools: pools,
            totalTvl: state.vaultReducer.totalTvl,
            totalPrizesAvailable: state.vaultReducer.totalPrizesAvailable,
            isPoolsLoading: false,
            lastUpdated: new Date().getTime()
        }
    });

    return true;
}

const getPoolsAll = async (state, dispatch) => {
    console.log('redux getPoolsAll() processing...');
    const web3 = state.walletReducer.rpc;
    const pools = state.vaultReducer.pools;
    const prices = state.pricesReducer.prices;
    const apy = state.pricesReducer.apy;

    const multicall = [];
    const calls = [];
    const sponsors = [];
    const strategy = [];

    for(let key in web3) {
        multicall[key] = new MultiCall(web3[key], config[key].multicallAddress);
        calls[key] = [];
        sponsors[key] = [];
        strategy[key] = [];
    }

    for (let key in pools) {
        const pool = pools[key];
        const gateContract = new web3[pool.network].eth.Contract(gateManagerAbi, pool.contractAddress);
        calls[pool.network].push({
            id: pool.id,
            awardBalance: gateContract.methods.awardBalance(),
            rewardRate: gateContract.methods.rewardRate(),
            totalValueLocked: gateContract.methods.TVL(),
        });

        const strategyContract = new web3[pool.network].eth.Contract(prizeStrategyAbi, pool.prizeStrategyAddress);
        strategy[pool.network].push({
            id: pool.id,
            expiresAt: strategyContract.methods.prizePeriodEndAt(),
        });

        if(!isEmpty(pool.sponsorAddress)) {
            const sponsorContract = new web3[pool.network].eth.Contract(ecr20Abi, pool.sponsorAddress);
            sponsors[pool.network].push({
                id: pool.id,
                sponsorBalance: sponsorContract.methods.balanceOf(pool.prizePoolAddress),
            });
        }
    }

    const promises = [];
    for(const key in multicall) {
        promises.push(multicall[key].all([calls[key]]));
        promises.push(multicall[key].all([strategy[key]]));
        promises.push(multicall[key].all([sponsors[key]]));
    }
    const results = await Promise.allSettled(promises);

    let response = [];
    results.forEach((result) => {
        if (result.status !== 'fulfilled') {
            console.warn('getPoolsAll error', result.reason);
            // FIXME: queue chain retry?
            return;
        }
        response = [...response, ...result.value[0]];
    });

    let totalPrizesAvailable = new BigNumber(0);

    for(let i = 0; i < response.length; i++) {
        const item = response[i];
        if(!isEmpty(item.awardBalance)) {
            const awardPrice = (pools[item.id].oracleId in prices) ? prices[pools[item.id].oracleId] : 0;
            const awardBalance = new BigNumber(item.awardBalance).dividedBy(new BigNumber(10).exponentiatedBy(pools[item.id].tokenDecimals));
            const awardBalanceUsd = awardBalance.times(awardPrice);

            pools[item.id].awardBalance = awardBalance;
            pools[item.id].awardBalanceUsd = awardBalanceUsd;
            pools[item.id].apy = (!isEmpty(apy) && pools[item.id].apyId in apy) ? (new BigNumber(apy[pools[item.id].apyId].totalApy).times(100).div(2).toFixed(2)) : 0;

            if(!isEmpty(pools[item.id].sponsorToken)) {
                const sponsorPrice = (pools[item.id].sponsorToken in prices) ? prices[pools[item.id].sponsorToken] : 0;
                const rewardRate = new BigNumber(item.rewardRate);
                const TotalValueLocked = new BigNumber(item.totalValueLocked);
                const totalStakedUsd = TotalValueLocked.times(awardPrice).dividedBy(new BigNumber(10).exponentiatedBy(pools[item.id].sponsorTokenDecimals));
                const yearlyRewards = rewardRate.times(3600).times(24).times(365);
                const yearlyRewardsInUsd = yearlyRewards.times(sponsorPrice).dividedBy(new BigNumber(10).exponentiatedBy(pools[item.id].sponsorTokenDecimals))

                pools[item.id].bonusApy = Number(yearlyRewardsInUsd.dividedBy(totalStakedUsd));
            }

            totalPrizesAvailable = totalPrizesAvailable.plus(awardBalanceUsd);
        }

        if(!isEmpty(item.expiresAt)) {
            pools[item.id].expiresAt = item.expiresAt;
        }

        if(!isEmpty(item.sponsorBalance)) {
            const sponsorPrice = (pools[item.id].sponsorToken in prices) ? prices[pools[item.id].sponsorToken] : 0;
            const sponsorBalance = new BigNumber(item.sponsorBalance).dividedBy(new BigNumber(10).exponentiatedBy(pools[item.id].sponsorTokenDecimals));
            const sponsorBalanceUsd = sponsorBalance.times(new BigNumber(sponsorPrice));

            pools[item.id].sponsorBalance = sponsorBalance;
            pools[item.id].sponsorBalanceUsd = sponsorBalanceUsd;

            totalPrizesAvailable = totalPrizesAvailable.plus(sponsorBalanceUsd);
        }
    }

    dispatch({
        type: HOME_FETCH_POOLS_DONE,
        payload: {
            pools: pools,
            totalTvl: state.vaultReducer.totalTvl,
            totalPrizesAvailable: totalPrizesAvailable,
            isPoolsLoading: false,
            lastUpdated: new Date().getTime()
        }
    });

    return true;
}

const fetchPools = (item = false) => {
    return async (dispatch, getState) => {
        const state = getState();
        dispatch({type: HOME_FETCH_POOLS_BEGIN});
        return item ? await getPoolsSingle(item, state, dispatch) : await getPoolsAll(state, dispatch);
    };
}

const obj = {
    fetchPools,
}

export default obj
