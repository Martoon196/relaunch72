/** Shared pure flags for operator-only media worker commands. */
export function workerCommandGate(env:NodeJS.ProcessEnv,action:string):void {
 if(env.RL72_MEDIA_WORKER_ENABLED!=='true')
   throw new Error('Media worker disabled by operator. No provider request made.');
 if(!['attest-native','serve','cleanup-objects','tick','probe','render-local'].includes(action))
   throw new Error('Usage: media:worker <probe|render-local|tick|serve> <workspace-uuid> <record-uuid>');
 if(action==='attest-native'&&(env.CREATIVE_MEDIA!=='enabled'||env.RL72_MEDIA_NATIVE_CALENDAR_ENABLED!=='true'))throw new Error('Native JIT disabled');
 if(action==='cleanup-objects'&&(env.CREATIVE_MEDIA!=='enabled'||env.RL72_MEDIA_PRIVATE_FILES_ENABLED!=='true'))throw new Error('Private object cleanup disabled');
 if(action==='serve'&&(env.RL72_MEDIA_SERVICE_ENABLED!=='true'||env.RL72_MEDIA_RETENTION_ENABLED!=='true'))throw new Error('Supervised media service disabled');
 if(['serve','tick'].includes(action)&&(env.CREATIVE_MEDIA!=='enabled'||env.RL72_MEDIA_LOCAL_RENDER_ENABLED!=='true'||env.RL72_MEDIA_DISPATCH_ENABLED!=='true'))throw new Error('Offline dispatch disabled');
 if(action==='render-local' &&
   (env.CREATIVE_MEDIA!=='enabled'||env.RL72_MEDIA_LOCAL_RENDER_ENABLED!=='true'))
   throw new Error('Local render is disabled and requires explicit operator approval.');
}
