import type { DestinationType } from '../types.js';
import { SeoBlogError } from '../types.js';
import { ContentApiPublisher } from './content-api.js';
import { GithubStaticPublisher } from './github-static.js';
import type { WebsitePublisher } from './types.js';

export type PublisherRegistry = ReadonlyMap<DestinationType, WebsitePublisher>;

export function defaultPublishers(): PublisherRegistry {
  return new Map<DestinationType, WebsitePublisher>([
    ['github_static', new GithubStaticPublisher()],
    ['content_api', new ContentApiPublisher()],
  ]);
}

export function publisherFor(registry: PublisherRegistry, type: string): WebsitePublisher {
  const publisher = registry.get(type as DestinationType);
  if (!publisher) throw new SeoBlogError(400, 'This website type is not supported yet. Supported: static site in a GitHub repository, or a website content API.');
  return publisher;
}
