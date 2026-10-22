"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { useFrame } from "../../../ui/frame.tsx";
import { EmptyState as IosEmptyState } from "../../../ui/ios/ios.tsx";
import { usePhone } from "../../../ui/look.tsx";
import { Button, Content, EmptyState } from "../../../ui/macos/macos.tsx";
import { IosPage, MacPage } from "../../../ui/page.tsx";
import type { AddPrefill } from "../../../ui/transaction-sheet.tsx";

/**
 * Opens the New Transaction sheet once, with the link's values, and swaps this URL for the
 * Transactions list underneath it — so Back does not reopen the sheet.
 *
 * With no account yet there is nothing to record against, so it says so instead (a transaction
 * has to come from somewhere).
 */
export function OpenNewTransaction({ prefill, hasAccounts }: { prefill: AddPrefill; hasAccounts: boolean }) {
  const phone = usePhone();
  const router = useRouter();
  const { addTransaction } = useFrame();
  const done = useRef(false);

  useEffect(() => {
    if (done.current || !hasAccounts) return;
    done.current = true;
    addTransaction(prefill);
    router.replace("/transactions");
  }, [addTransaction, hasAccounts, prefill, router]);

  if (hasAccounts) return null;
  const message = "A transaction has to come from somewhere. Create a bank, cash, wallet or card account, then come back.";
  return phone ? (
    <IosPage title="New Transaction" back={{ label: "Transactions", href: "/transactions" }}>
      <IosEmptyState icon="creditcard" title="Add an Account First" description={message} actionLabel="Go to Accounts" onAction={() => router.push("/accounts")} />
    </IosPage>
  ) : (
    <MacPage
      title="New Transaction"
      body={
        <Content>
          <EmptyState icon="creditcard" title="Add an Account First" message={message} actions={<Button variant="prominent" onClick={() => router.push("/accounts")}>Go to Accounts</Button>} />
        </Content>
      }
    />
  );
}
