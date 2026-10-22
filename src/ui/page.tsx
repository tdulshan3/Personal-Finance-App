"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { ReactNode } from "react";

import { lockAction } from "../app/actions.ts";
import { BarButton, Icon as IosIcon, NavigationBar } from "./ios/ios.tsx";
import type { IconName } from "./labels.ts";
import { useLiveProblem } from "./live-sync.tsx";
import { usePhone } from "./look.tsx";
import { Content, Icon as MacIcon, SidebarToggle, Stack, Titlebar, ToolbarButton } from "./macos/macos.tsx";

/**
 * The two page skeletons, straight from the apple-ui-ux templates.
 *
 * macOS: the title bar (Show/Hide Sidebar first, the page's commands, Lock, search last) over the
 * one scrolling content area with its stack of sections. iOS: the navigation bar first — a large
 * title on a section's first screen, an inline title and a back button on a pushed one — then the
 * page's lists and cards. Both return fragments; no wrapper element sits between them and the shell.
 *
 * The live link's trouble, when there is any, takes over the subtitle: that is where both kits put
 * live status.
 */

export function MacPage({
  title,
  subtitle,
  toolbar,
  search,
  children,
  body,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Toolbar items: <ToolbarButton>s, a <SegmentedControl>, a <PopUpButton>. */
  toolbar?: ReactNode;
  /** A <SearchField>, which the kit puts last, at the top right. */
  search?: ReactNode;
  /** The page as a <Stack> of sections, in the standard scrolling content area. */
  children?: ReactNode;
  /** Instead of `children`: the page's own panes (a <WindowBody> with an inspector, a flush table). */
  body?: ReactNode;
}) {
  const problem = useLiveProblem();
  return (
    <>
      <Titlebar title={title} subtitle={problem ?? subtitle} leading={<SidebarToggle sidebarId="sidebar" />}>
        {toolbar}
        <LockToolbarButton />
        {search}
      </Titlebar>
      {body ?? (
        <Content>
          <Stack>{children}</Stack>
        </Content>
      )}
    </>
  );
}

function LockToolbarButton() {
  const [pending, start] = useTransition();
  return <ToolbarButton icon="lock" label="Lock" disabled={pending} onClick={() => start(() => lockAction())} />;
}

export function IosPage({
  title,
  subtitle,
  back,
  leading,
  trailing,
  accessory,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /**
   * A pushed screen: the inline title and a back button to the screen it came from — a route, or,
   * for a screen pushed within the page (the kit templates' "navigation is state"), a callback.
   */
  back?: { label: string; href: Route } | { label: string; onBack: () => void } | undefined;
  leading?: ReactNode;
  trailing?: ReactNode;
  accessory?: ReactNode;
  children?: ReactNode;
}) {
  const problem = useLiveProblem();
  const router = useRouter();
  return (
    <>
      <NavigationBar
        variant={back ? "inline" : "large"}
        title={title}
        subtitle={problem ?? subtitle}
        leading={
          back ? (
            <BarButton back onClick={() => ("href" in back ? router.push(back.href) : back.onBack())}>
              {back.label}
            </BarButton>
          ) : (
            leading
          )
        }
        trailing={trailing}
        accessory={accessory}
      />
      {children}
    </>
  );
}

/** A kit symbol in the current look. Decorative: whatever it sits in carries the name. */
export function KitIcon({ name }: { name: IconName }) {
  return usePhone() ? <IosIcon name={name} /> : <MacIcon name={name} />;
}

export type Tone = "good" | "warning" | "bad" | "neutral";

/**
 * A status word with its symbol, in the status colour (the kits' one allowed use of coloured text
 * besides links and category labels). Never colour alone: the symbol and the words carry it too.
 */
export function Status({ tone, icon, children }: { tone: Tone; icon?: IconName; children: ReactNode }) {
  const phone = usePhone();
  const colour =
    tone === "neutral"
      ? phone ? "ios-label-secondary" : "mac-label-secondary"
      : phone
        ? { good: "ios-text-green", warning: "ios-text-orange", bad: "ios-text-red" }[tone]
        : { good: "mac-label-green", warning: "mac-label-orange", bad: "mac-label-red" }[tone];
  const symbol = icon ?? (tone === "good" ? "checkmark-circle-fill" : tone === "neutral" ? "info-circle" : "exclamationmark-triangle");
  return (
    <span className={colour}>
      <KitIcon name={symbol} /> {children}
    </span>
  );
}

/** Secondary-label text, for a sentence that explains rather than states. */
export function Secondary({ children }: { children: ReactNode }) {
  return <span className={usePhone() ? "ios-label-secondary" : "mac-label-secondary"}>{children}</span>;
}

/** A FormData from plain values, for the server actions that read their input as a form. */
export function formData(values: Record<string, string | number | boolean | null | undefined>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === false) continue;
    data.set(key, value === true ? "on" : String(value));
  }
  return data;
}
