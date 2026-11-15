/** Shared pure flags for operator-only media worker commands. */
export function workerCommandGate(env:NodeJS.ProcessEnv,action:string):void {
 if(env.RL72_MEDIA_WORKER_ENABLED!=='true')
   throw new Error('Media worker disabled by operator. No provider request made.');
 if(!['probe','probe-output','render-local','submit','reconcile'].includes(action))
   throw new Error('Usage: media:worker <probe|probe-output|render-local|submit|reconcile> <workspace-uuid> <record-uuid>');
 if(action==='render-local' &&
   (env.CREATIVE_MEDIA!=='enabled'||env.RL72_MEDIA_LOCAL_RENDER_ENABLED!=='true'))
   throw new Error('Local render is disabled and requires explicit operator approval.');
 if(action==='submit'&&env.RL72_MEDIA_PROVIDER_SUBMISSIONS_ALLOWED!=='true')
   throw new Error('Paid provider submission not permitted by operator.');
 if(action==='reconcile'&&env.RL72_MEDIA_PROVIDER_READS_ALLOWED!=='true')
   throw new Error('Read-only provider inspection not permitted by operator.');
}
