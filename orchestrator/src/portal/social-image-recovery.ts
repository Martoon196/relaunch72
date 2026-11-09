/** Pause new picture attachments without hiding saved images or stopping other journeys. */
export function socialImageCreationPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROPERTY_PREDATOR_POST_IMAGE_CREATION_PAUSED?.trim().toLowerCase() === 'true';
}
