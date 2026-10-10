/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as ai_provider_settings from "../ai_provider_settings.js";
import type * as attempts from "../attempts.js";
import type * as audioSettings from "../audioSettings.js";
import type * as cards from "../cards.js";
import type * as chatAgents from "../chatAgents.js";
import type * as chatCitations from "../chatCitations.js";
import type * as chatContext from "../chatContext.js";
import type * as citationFields from "../citationFields.js";
import type * as conversations from "../conversations.js";
import type * as learning from "../learning.js";
import type * as preparation from "../preparation.js";
import type * as projectAgents from "../projectAgents.js";
import type * as projects from "../projects.js";
import type * as research from "../research.js";
import type * as settings from "../settings.js";
import type * as sourceRetrieval from "../sourceRetrieval.js";
import type * as sources from "../sources.js";
import type * as study from "../study.js";
import type * as teach from "../teach.js";
import type * as topics from "../topics.js";
import type * as units from "../units.js";
import type * as workspaceChats from "../workspaceChats.js";
import type * as writing from "../writing.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  ai_provider_settings: typeof ai_provider_settings;
  attempts: typeof attempts;
  audioSettings: typeof audioSettings;
  cards: typeof cards;
  chatAgents: typeof chatAgents;
  chatCitations: typeof chatCitations;
  chatContext: typeof chatContext;
  citationFields: typeof citationFields;
  conversations: typeof conversations;
  learning: typeof learning;
  preparation: typeof preparation;
  projectAgents: typeof projectAgents;
  projects: typeof projects;
  research: typeof research;
  settings: typeof settings;
  sourceRetrieval: typeof sourceRetrieval;
  sources: typeof sources;
  study: typeof study;
  teach: typeof teach;
  topics: typeof topics;
  units: typeof units;
  workspaceChats: typeof workspaceChats;
  writing: typeof writing;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
