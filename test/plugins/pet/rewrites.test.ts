import { describe, expect, it } from "vitest";
import {
  CXP_PETS_STACK_MAX_HEIGHT_HOOK,
  CXP_PETS_STACK_PATCHED_MARKER,
  CXP_QUICK_CHAT_TARGET_HOOK,
  petClientThreadLinkRewrite,
  petQuickChatTargetRewrite,
  petRewrites,
  petStackMaxHeightRewrite,
} from "../../../plugins/pet/rewrites.ts";

/** Minified shapes of the Codex Pet chunk expressions from codex-host fork tests. */
const STACK =
  "activityStackMaxViewportHeight$:a(e=>{let t=e(i).quickChat;return null==t?d.e3:Math.max(d.YMX,t.workArea.height/2-d.Zam-d.rqb)})";
const QUICK_CHAT =
  'p=await (0,b.Nw)({scope:D,turnTrigger:"avatar_quick_chat",threadSource:"avatar_quick_chat",model:void 0,prompt:e,target:{type:"projectless",clientThreadId:t},thinking:void 0})';
const CREATE_THREAD =
  'em=await t(e,ea,c,{assertRequestCurrent:l,clientThreadId:"projectless"===N.type?N.clientThreadId:void 0,onSettled:d})';

function applyAll(source: string): string | null {
  let current = source;
  let matched = false;
  for (const rule of petRewrites) {
    if (!rule.identify(current)) continue;
    matched = true;
    const next = rule.apply(current);
    if (next === null) return null;
    current = next;
  }
  return matched ? current : null;
}

describe("pet ChunkRewrite rules", () => {
  it("routes stack height and Quick Chat target through plugin-owned hooks", () => {
    const combined = `${STACK};${QUICK_CHAT}`;
    expect(petStackMaxHeightRewrite.identify(combined)).toBe(true);
    expect(petQuickChatTargetRewrite.identify(combined)).toBe(true);
    expect(petClientThreadLinkRewrite.identify(combined)).toBe(false);

    const patched = applyAll(combined) ?? "";
    expect(patched.startsWith(`globalThis.${CXP_PETS_STACK_PATCHED_MARKER}=true;`)).toBe(true);
    expect(patched).toContain(
      `((h)=>globalThis.${CXP_PETS_STACK_MAX_HEIGHT_HOOK}?.(t,h)??h)(null==t?d.e3:`,
    );
    expect(patched).toContain(
      `target:(globalThis.${CXP_QUICK_CHAT_TARGET_HOOK}?.(t)??{type:"projectless",clientThreadId:t})`,
    );
  });

  it("links a remote project Quick Chat thread to its client thread id", () => {
    expect(petClientThreadLinkRewrite.identify(CREATE_THREAD)).toBe(true);
    expect(petClientThreadLinkRewrite.apply(CREATE_THREAD)).toContain(
      'clientThreadId:"projectless"===N.type||"remoteProject"===N.type?N.clientThreadId:void 0,',
    );
  });

  it("leaves other projectless targets and unrelated chunks unchanged", () => {
    const other = 'threadSource:"other",target:{type:"projectless",clientThreadId:t}';
    for (const rule of petRewrites) {
      expect(rule.identify(other)).toBe(false);
      expect(rule.apply(other)).toBeNull();
    }
    expect(applyAll(other)).toBeNull();
  });

  it("returns null from apply when a recognized chunk no longer matches the expected expression", () => {
    const brokenStack = "activityStackMaxViewportHeight$:a(e=>{return 208})";
    expect(petStackMaxHeightRewrite.identify(brokenStack)).toBe(true);
    expect(petStackMaxHeightRewrite.apply(brokenStack)).toBeNull();

    const brokenQuickChat =
      'p=await f({threadSource:"avatar_quick_chat",target:{type:"local",id:t}})';
    expect(petQuickChatTargetRewrite.identify(brokenQuickChat)).toBe(true);
    expect(petQuickChatTargetRewrite.apply(brokenQuickChat)).toBeNull();

    const brokenLink =
      'em=await t(e,ea,c,{assertRequestCurrent:l,clientThreadId:N.clientThreadId,onSettled:d})';
    expect(petClientThreadLinkRewrite.identify(brokenLink)).toBe(true);
    expect(petClientThreadLinkRewrite.apply(brokenLink)).toBeNull();
  });
});
