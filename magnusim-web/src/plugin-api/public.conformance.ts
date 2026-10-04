/**
 * Holds the real host object to the published types in ./public.ts
 * (docs/plugins/plugin-api.d.ts). `npm run typecheck` fails when the page
 * passes a plugin something the published types do not describe, or when the
 * published types promise a member the page does not pass.
 */
import type { PluginHost as RealPluginHost } from '../plugins/loader';
import type { PluginHost, PluginUi } from './public';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The real host is a PluginHost as published. */
export const realHostIsPublished = (host: RealPluginHost): PluginHost => host;

/** The published PluginUi names exactly the members the page passes. */
export const sameMembers: Same<keyof RealPluginHost['pluginUi'], keyof PluginUi> = true;
/** The published PluginHost names exactly the members the page passes. */
export const sameHostMembers: Same<keyof RealPluginHost, keyof PluginHost> = true;
