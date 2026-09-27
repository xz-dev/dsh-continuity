import { ContinuityEngine } from './engine.js';
export const name='dsh-continuity-engine';
export const inject=ContinuityEngine.inject;
export function apply(ctx,config={}) { ctx.plugin(ContinuityEngine,config); }
export default {name,inject,apply};
