"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Money } from "../../core/domain/money.ts";
import { shortDate, signedAmount } from "../../ui/format.ts";
import { EmptyState as IosEmptyState, List, ListRow, ListRowAction, ListSection } from "../../ui/ios/ios.tsx";
import type { IconName } from "../../ui/labels.ts";
import { usePhone } from "../../ui/look.tsx";
import { Button, ContextMenu, EmptyState, MenuItem, Row, Section, Table, Tile, ToolbarButton } from "../../ui/macos/macos.tsx";
import type { RowId, TableColumn } from "../../ui/macos/macos.tsx";
import { IosPage, MacPage, Status } from "../../ui/page.tsx";
import { useTrashCommands } from "../transactions/trash-commands.tsx";

export type ActivityEvent = {
  id: string;
  actor: string;
  actorKind: string;
  modelIdentity: string | null;
  origin: string;
  reason: string;
  at: number;
  when: string;
  transactionId: string | null;
  subject: string;
  changes: string[];
};

export type TrashRow = {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  categoryName: string | null;
  icon: IconName;
  account: string | null;
  date: string;
  labels: string;
  amount: Money;
  revision: number;
};

export type ActivityData = {
  today: string;
  events: ActivityEvent[];
  eventLimitReached: boolean;
  trash: TrashRow[];
  trashLimitReached: boolean;
};

/** Who made a change, as a symbol: the owner, the assistant, an import, the app itself. */
function actorIcon(kind: string): IconName {
  switch (kind) {
    case "owner":
      return "person";
    case "agent":
      return "bubble-left";
    case "import":
      return "tray-and-arrow-down";
    default:
      return "gear";
  }
}

/** "You · ui.accounts.reconcile", with the model named when the assistant made the change. */
const byline = (event: ActivityEvent) => [event.actor, event.origin, event.modelIdentity].filter(Boolean).join(" · ");

export function ActivityView({ data }: { data: ActivityData }) {
  return usePhone() ? <IosActivity data={data} /> : <MacActivity data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* macOS                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function MacActivity({ data }: { data: ActivityData }) {
  const router = useRouter();
  const trash = useTrashCommands();
  const [eventSelection, setEventSelection] = useState<RowId[]>([]);
  const [trashSelection, setTrashSelection] = useState<RowId[]>([]);
  const event = data.events.find((e) => eventSelection.includes(e.id));
  const deleted = data.trash.find((t) => trashSelection.includes(t.id));
  const openRecord = (id: string | null | undefined) => id && router.push(`/transactions/${id}` as Route);
  const restore = (row: TrashRow | undefined) => row && trash.restore({ id: row.id, revision: row.revision, title: row.title });

  const eventColumns: TableColumn<ActivityEvent>[] = [
    { key: "at", title: "When", width: 160, render: (e) => e.when },
    { key: "reason", title: "Change" },
    { key: "subject", title: "Record", width: "22%", render: (e) => e.subject || "--" },
    { key: "changes", title: "What changed", width: "26%", sortable: false, render: (e) => (e.changes.length > 0 ? e.changes.join("; ") : "--") },
    { key: "actor", title: "By", width: 120 },
  ];
  const trashColumns: TableColumn<TrashRow>[] = [
    { key: "date", title: "Date", width: 96, render: (r) => shortDate(r.date, data.today) },
    {
      key: "title",
      title: "Merchant or payer",
      render: (r) => (
        <>
          {r.title}
          {r.labels ? <span className="mac-label-secondary"> · {r.labels}</span> : null}
        </>
      ),
    },
    { key: "categoryName", title: "Category", width: "18%", render: (r) => r.categoryName ?? r.kindLabel },
    { key: "account", title: "Account", width: "20%", render: (r) => r.account ?? "--" },
    { key: "amount", title: "Amount", width: 150, numeric: true, sortValue: (r) => Number(r.amount.minor), render: (r) => signedAmount(r.kind, r.amount) },
  ];

  return (
    <MacPage
      title="Activity"
      subtitle={trash.message ? <Status tone={trash.message.tone}>{trash.message.text}</Status> : "Every change to your records, newest first"}
      toolbar={
        <>
          <ToolbarButton icon="doc-text" label="Open Record" disabled={!event?.transactionId && !deleted} onClick={() => openRecord(event?.transactionId ?? deleted?.id)} />
          <ToolbarButton icon="arrow-uturn-left" label="Restore from Trash" disabled={!deleted || trash.pending} onClick={() => restore(deleted)} />
        </>
      }
    >
      <Section
        title="Recent changes"
        footer={data.eventLimitReached ? `Showing the latest ${data.events.length} changes. The audit trail itself keeps every one and can never be edited.` : "The audit trail is append-only: nothing here can be changed or removed."}
      >
        {data.events.length === 0 ? (
          <Tile>
            <EmptyState title="Nothing Has Changed Yet" message="Once you add, edit or delete a record, each change is listed here with who made it." />
          </Tile>
        ) : (
          <Tile flush>
            <ContextMenu menu={<MenuItem icon="doc-text" disabled={!event?.transactionId} onSelect={() => openRecord(event?.transactionId)}>Open Record</MenuItem>}>
              <Table
                label="Recent changes"
                columns={eventColumns}
                rows={data.events}
                rowIcon={(e) => actorIcon(e.actorKind)}
                selection={eventSelection}
                onSelectionChange={setEventSelection}
                onRowAction={(e) => openRecord(e.transactionId)}
              />
            </ContextMenu>
          </Tile>
        )}
      </Section>

      <Section
        title="Trash"
        actions={
          <Row>
            <Button size="small" disabled={!deleted || trash.pending} onClick={() => restore(deleted)}>Restore</Button>
            <Button size="small" onClick={() => router.push("/transactions?view=trash" as Route)}>See All</Button>
          </Row>
        }
        footer={
          data.trashLimitReached
            ? `Showing the first ${data.trash.length}. Their effect on your balances is already reversed; restoring one brings it back.`
            : "Their effect on your balances is already reversed; restoring one brings it back."
        }
      >
        {data.trash.length === 0 ? (
          <Tile>
            <EmptyState icon="trash" title="Trash Is Empty" message="Deleted transactions wait here until you restore them." />
          </Tile>
        ) : (
          <Tile flush>
            <ContextMenu
              menu={
                <>
                  <MenuItem icon="arrow-uturn-left" disabled={!deleted} onSelect={() => restore(deleted)}>Restore</MenuItem>
                  <MenuItem icon="doc-text" disabled={!deleted} onSelect={() => openRecord(deleted?.id)}>Open</MenuItem>
                </>
              }
            >
              <Table
                label="Trash"
                columns={trashColumns}
                rows={data.trash}
                rowIcon={(r) => r.icon}
                selection={trashSelection}
                onSelectionChange={setTrashSelection}
                onRowAction={(r) => openRecord(r.id)}
              />
            </ContextMenu>
          </Tile>
        )}
      </Section>
      {trash.dialog}
    </MacPage>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS                                                                                          */
/* ------------------------------------------------------------------------------------------ */

function IosActivity({ data }: { data: ActivityData }) {
  const trash = useTrashCommands();
  if (data.events.length === 0 && data.trash.length === 0) {
    return (
      <IosPage title="Activity" back={{ label: "Home", href: "/" }}>
        <IosEmptyState icon="clock" title="Nothing Has Changed Yet" description="Once you add, edit or delete a record, each change is listed here with who made it." />
      </IosPage>
    );
  }
  return (
    <IosPage
      title="Activity"
      back={{ label: "Home", href: "/" }}
      subtitle={trash.message ? <Status tone={trash.message.tone}>{trash.message.text}</Status> : undefined}
    >
      <List>
        <ListSection
          header="Recent Changes"
          footer={data.eventLimitReached ? `The latest ${data.events.length} changes. The audit trail keeps every one and can never be edited.` : "The audit trail is append-only: nothing here can be changed or removed."}
        >
          {data.events.length === 0 ? (
            <ListRow title="Nothing has changed yet" />
          ) : (
            data.events.map((event) => (
              <ListRow
                key={event.id}
                title={event.reason}
                subtitle={[event.subject || null, ...event.changes, `${byline(event)} · ${event.when}`].filter(Boolean).join(" · ")}
                icon={actorIcon(event.actorKind)}
                iconColor={event.actorKind === "agent" ? "indigo" : event.actorKind === "import" ? "orange" : "gray"}
                {...(event.transactionId ? { href: `/transactions/${event.transactionId}` } : {})}
              />
            ))
          )}
        </ListSection>

        <ListSection
          header="Trash"
          footer={
            data.trashLimitReached
              ? `The first ${data.trash.length}. Their effect on your balances is already reversed; swipe one to restore it.`
              : "Their effect on your balances is already reversed. Swipe one to restore it."
          }
        >
          {data.trash.length === 0 ? (
            <ListRow title="Trash is empty" />
          ) : (
            data.trash.map((row) => (
              <ListRow
                key={row.id}
                title={row.title}
                subtitle={[shortDate(row.date, data.today), row.categoryName ?? row.kindLabel, row.labels || null].filter(Boolean).join(" · ")}
                detail={signedAmount(row.kind, row.amount, false)}
                href={`/transactions/${row.id}`}
                trailingActions={<ListRowAction label="Restore" icon="arrow-uturn-left" color="accent" onClick={() => trash.restore({ id: row.id, revision: row.revision, title: row.title })} />}
              />
            ))
          )}
          {data.trashLimitReached ? <ListRow title="See All of Trash" href="/transactions?view=trash" /> : null}
        </ListSection>
      </List>
      {trash.dialog}
    </IosPage>
  );
}
