import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import yaml from 'js-yaml';
import { ContinuityEngine } from './engine.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction';

export const name = 'dsh-continuity';
export const inject = ['agentPresets','commands'];

// Read current official standard composition instead of shipping a drifting copy.
// Standard's source stays version-pinned through the DSH peer dependency.
export async function continuityPreset(load = readFile) {
  const require = createRequire(import.meta.url);
  const source = require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
  const patch = yaml.load(await load(source,'utf8'),{schema:entryListSchema});
  const definition = structuredClone(patch?.[0]?.insert?.[0]?.config);
  if (definition?.id !== 'standard' || !Array.isArray(definition.plugins)) throw Error('standard preset declaration unavailable');
  const group = definition.plugins.find(x=>x.id==='compaction');
  const row = group?.config?.find(x=>x.id==='compaction-basic');
  if (!row || !group.isolate?.compaction) throw Error('standard preset has no isolated basic compaction');
  row.name=new URL('./engine-plugin.js',import.meta.url).href;
  row.config={};
  definition.id='continuity';
  definition.name='Continuity';
  definition.description='Standard tools with source-verified continuity compaction';
  return definition;
}

export async function continuityCommand(ctx, invocation) {
  const mode=invocation.rawInput.trim();
  if(mode && mode!=='continue') return {kind:'error',text:'Usage: /continuity [continue]'};
  const engine=ctx.agentPresets.serviceFor(invocation.agent,'compaction');
  if(!(engine instanceof ContinuityEngine)) return {kind:'error',text:'Continuity preset is not active; select /preset continuity.'};
  try {
    const result=await engine.compactWithContinuity(invocation.agent,invocation.signal,invocation.commandId);
    if(result===null) return {kind:'success',text:'No compactable history yet.'};
    if(mode==='continue' && !invocation.signal.aborted) {
      invocation.agent.followup(createUserMessage({content:[{type:'text',text:'Continue the work represented by the just-committed continuity summary.'}],source:{kind:'continuity/continue'}}));
    }
    return {kind:'success',text:`Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,sourceEventSeq:result.summarySeq};
  } catch(error) {
    if(error?.message==='already-pending') return {kind:'error',text:'Continuity compaction is already pending.'};
    if(invocation.signal.aborted || error instanceof ManualCompactionError && error.code==='cancelled') return {kind:'error',text:'Compaction cancelled.'};
    if(error instanceof ManualCompactionError) return {kind:'error',text:`Continuity compaction failed (${error.code}); inspect current session state before retrying.`};
    throw error;
  }
}

export async function apply(ctx) {
  const preset=await continuityPreset();
  ctx.effect(async function* () { yield await ctx.agentPresets.register(preset); });
  ctx.effect(function* () { yield ctx.commands.register({name:'continuity',description:'Compact with continuity summary; add continue to resume',handler: inv=>continuityCommand(ctx,inv)}); });
}

export default {name,inject,apply};
export {ContinuityEngine};
