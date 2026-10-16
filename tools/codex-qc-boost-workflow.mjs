import {loadQianchuanModule} from './codex-qc-module-bundle.mjs';
export const loadQianchuanBoostReplay = config => loadQianchuanModule({...config,entry:'codex-qc-boost-replay.cua.js'});
export const loadQianchuanControlPools = config => loadQianchuanModule({...config,entry:'codex-qc-control-pools.cua.js'});
