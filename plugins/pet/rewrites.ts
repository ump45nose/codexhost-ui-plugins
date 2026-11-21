// Copyright (C) CodexHost contributors.
// SPDX-License-Identifier: LGPL-3.0-only
// Ported from codex-host packages/desktop-control/src/avatar-overlay-chunk-patch.ts.
// Loaded directly by Node via type stripping: strictly erasable TS syntax only.

import type { ChunkRewrite } from "../types.ts";

export const CXP_PETS_STACK_PATCHED_MARKER = "__cxpPetsStackPatched";
export const CXP_PETS_STACK_MAX_HEIGHT_HOOK = "__cxpPetsStackMaxHeight";
export const CXP_QUICK_CHAT_TARGET_HOOK = "__cxpQuickChatTarget";

const STACK_HEIGHT_MARKER = "activityStackMaxViewportHeight$:";
const STACK_HEIGHT_EXPRESSION =
  /(activityStackMaxViewportHeight\$:[\w$]+\(([\w$]+)=>\{let ([\w$]+)=\2\([\w$]+\)\.quickChat;return )([^{};]+)\}/;

const QUICK_CHAT_TARGET_MARKER = 'threadSource:"avatar_quick_chat"';
const QUICK_CHAT_TARGET_EXPRESSION =
  /(threadSource:"avatar_quick_chat",[^;]{0,300}?target:)\{type:"projectless",clientThreadId:([\w$]+)\}/;

const CLIENT_THREAD_LINK_MARKER = /assertRequestCurrent:[\w$]+,clientThreadId:/;
const CLIENT_THREAD_LINK_EXPRESSION =
  /(assertRequestCurrent:[\w$]+,clientThreadId:)"projectless"===([\w$]+)\.type\?\2\.clientThreadId:void 0/;

export const petStackMaxHeightRewrite: ChunkRewrite = {
  name: "pet-stack-max-height",
  identify(source: string): boolean {
    return source.includes(STACK_HEIGHT_MARKER);
  },
  apply(source: string): string | null {
    const stack = STACK_HEIGHT_EXPRESSION.exec(source);
    if (!stack) return null;
    const [whole, head, , quickChat, nativeHeight] = stack;
    return `globalThis.${CXP_PETS_STACK_PATCHED_MARKER}=true;${source.slice(0, stack.index)}${head}((h)=>globalThis.${CXP_PETS_STACK_MAX_HEIGHT_HOOK}?.(${quickChat},h)??h)(${nativeHeight})}${source.slice(stack.index + whole.length)}`;
  },
};

export const petQuickChatTargetRewrite: ChunkRewrite = {
  name: "pet-quick-chat-target",
  identify(source: string): boolean {
    return source.includes(QUICK_CHAT_TARGET_MARKER);
  },
  apply(source: string): string | null {
    const target = QUICK_CHAT_TARGET_EXPRESSION.exec(source);
    if (!target) return null;
    const [whole, head, clientThreadId] = target;
    return `${source.slice(0, target.index)}${head}(globalThis.${CXP_QUICK_CHAT_TARGET_HOOK}?.(${clientThreadId})??{type:"projectless",clientThreadId:${clientThreadId}})${source.slice(target.index + whole.length)}`;
  },
};

export const petClientThreadLinkRewrite: ChunkRewrite = {
  name: "pet-client-thread-link",
  identify(source: string): boolean {
    return CLIENT_THREAD_LINK_MARKER.test(source);
  },
  apply(source: string): string | null {
    const link = CLIENT_THREAD_LINK_EXPRESSION.exec(source);
    if (!link) return null;
    const [whole, head, threadTarget] = link;
    return `${source.slice(0, link.index)}${head}"projectless"===${threadTarget}.type||"remoteProject"===${threadTarget}.type?${threadTarget}.clientThreadId:void 0${source.slice(link.index + whole.length)}`;
  },
};

export const petRewrites: ChunkRewrite[] = [
  petStackMaxHeightRewrite,
  petQuickChatTargetRewrite,
  petClientThreadLinkRewrite,
];
