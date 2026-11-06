import type { DestinationType } from '../types.js';
import { SeoBlogError } from '../types.js';
import { ContentApiPublisher } from './content-api.js';
import { GithubStaticPublisher } from './github-static.js';
import { WordPressPublisher } from './wordpress.js';
import type { WebsitePublisher } from './types.js';

export type PublisherRegistry = ReadonlyMap<DestinationType, WebsitePublisher>;

export function defaultPublishers(): PublisherRegistry {
  return new Map<DestinationType, WebsitePublisher>([
    ['github_static', new GithubStaticPublisher()],
    ['content_api', new ContentApiPublisher()],
    ['wordpress', new WordPressPublisher()],
  ]);
}

export function publisherFor(registry: PublisherRegistry, type: string): WebsitePublisher {
  const publisher = registry.get(type as DestinationType);
  if (!publisher) throw new SeoBlogError(400, 'This website type is not supported yet. Supported: static site in a GitHub repository, a website content API, or WordPress with the Relaunch72 Publisher plugin.');
  return publisher;
}
