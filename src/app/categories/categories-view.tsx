"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import type { Money } from "../../core/domain/money.ts";
import { money, plainAmount, plural } from "../../ui/format.ts";
import {
  ActionSheet,
  BarButton,
  Button as IosButton,
  List,
  ListRow,
  ListSection,
  PopUpButton as IosPopUp,
  ProgressBar as IosProgress,
  SegmentedControl as IosSegmented,
  Sheet as IosSheet,
  TextField as IosTextField,
} from "../../ui/ios/ios.tsx";
import { IosFieldRow } from "../../ui/ios-parts.tsx";
import type { IconName } from "../../ui/labels.ts";
import { CATEGORY_ICONS } from "../../ui/labels.ts";
import { usePhone } from "../../ui/look.tsx";
import {
  Alert,
  Button,
  Content,
  ContextMenu,
  EmptyState,
  FieldGrid,
  Form,
  FormRow,
  FormSection,
  FormValue,
  Inspector,
  MenuItem,
  MenuSeparator,
  ProgressBar,
  Section,
  SegmentedControl,
  Sheet,
  Stack,
  Table,
  TextField,
  Tile,
  ToolbarButton,
  WindowBody,
} from "../../ui/macos/macos.tsx";
import type { TableColumn } from "../../ui/macos/macos.tsx";
import type { Tone } from "../../ui/page.tsx";
import { IosPage, KitIcon, MacPage, Status, formData } from "../../ui/page.tsx";
import type { CategoryState } from "./actions.ts";
import { createCategoryAction, setBudgetAction, setCategoryArchivedAction, updateCategoryAction } from "./actions.ts";

export type CategoryItem = {
  id: string;
  name: string;
  kind: "expense" | "income";
  icon: IconName;
  /** A system colour name for the iOS icon tile. */
  color: string;
  uses: number;
  archived: boolean;
  /** Named by the app itself (income, uncategorized, fees): always pickable, never archived. */
  protected: boolean;
  /** Spent (or, for income, received) this month. */
  thisMonth: Money;
  budget: { limit: Money; spent: Money; remaining: Money; ratio: number; projected: Money; status: "under" | "near" | "over" } | null;
  suggestion: { average: Money; suggested: Money } | null;
};

export type CategoriesData = {
  currency: string;
  /** "October 2026". */
  monthLabel: string;
  categories: CategoryItem[];
};

/** Names for the kit symbols offered, so a menu reads "Cart" rather than "cart". */
const ICON_NAMES: Partial<Record<IconName, string>> = {
  cart: "Cart",
  "flame-fill": "Flame",
  "figure-walk": "Walking",
  house: "House",
  bolt: "Bolt",
  heart: "Heart",
  book: "Book",
  tag: "Tag",
  film: "Film",
  "doc-text": "Receipt",
  "arrow-down-circle": "Money In",
  "drop-fill": "Drop",
  leaf: "Leaf",
  phone: "Phone",
  wifi: "Wi-Fi",
  globe: "Globe",
  paperplane: "Travel",
  "person-2": "People",
  star: "Star",
  "music-note": "Music",
  eyeglasses: "Glasses",
  bed: "Bed",
  cloud: "Cloud",
  key: "Key",
  gear: "Gear",
  "questionmark-circle": "Question Mark",
};
const iconName = (icon: IconName) => ICON_NAMES[icon] ?? icon;

const PROTECTED_REASON = "The app files money here by itself, so it can't be archived.";

/** The budget's state as a status word: how much is used, or by how much it is over. */
function budgetStatus(budget: NonNullable<CategoryItem["budget"]>): { tone: Tone; text: string } {
  const percent = Math.round(budget.ratio * 100);
  if (budget.status === "over") return { tone: "bad", text: `Over by ${money({ ...budget.remaining, minor: -budget.remaining.minor })}` };
  if (budget.status === "near") return { tone: "warning", text: `${percent}% used` };
  return { tone: "neutral", text: `${percent}% used` };
}

function useAction() {
  const [pending, start] = useTransition();
  const run = (
    action: (prev: CategoryState, data: FormData) => Promise<CategoryState>,
    values: Record<string, string | number | null | undefined>,
    done?: (result: CategoryState) => void,
  ) => start(async () => done?.(await action({}, formData(values))));
  return { pending, run };
}

export function CategoriesView({ data }: { data: CategoriesData }) {
  return usePhone() ? <IosCategories data={data} /> : <MacCategories data={data} />;
}

/* ------------------------------------------------------------------------------------------ */
/* Sheets: a category (new or edited), and a monthly budget                                    */
/* ------------------------------------------------------------------------------------------ */

function CategorySheet({ open, editing, onClose }: { open: boolean; editing: CategoryItem | null; onClose: () => void }) {
  const phone = usePhone();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [icon, setIcon] = useState<IconName>("tag");
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useAction();
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setKind(editing?.kind ?? "expense");
    setIcon(editing?.icon ?? "tag");
    setError(null);
  }, [open, editing?.id, editing?.name, editing?.icon, editing?.kind]);

  const canSave = name.trim().length > 0 && !pending;
  const save = () => {
    if (!canSave) return;
    setError(null);
    const done = (result: CategoryState) => (result.error ? setError(result.error) : onClose());
    if (editing) run(updateCategoryAction, { id: editing.id, name, icon }, done);
    else run(createCategoryAction, { name, kind, icon }, done);
  };
  const title = editing ? "Edit Category" : "New Category";
  const kindNote = editing
    ? "Whether a category is for spending or income is fixed once it exists: history is filed by it."
    : "Spending categories appear for expenses and refunds; income categories for income.";

  if (phone) {
    return (
      <IosSheet
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title={title}
        leading={<IosButton variant="glass" onClick={onClose}>Cancel</IosButton>}
        trailing={
          <IosButton variant="glass-prominent" disabled={!canSave} onClick={save}>
            {pending ? "Saving…" : editing ? "Save" : "Add"}
          </IosButton>
        }
      >
        <List>
          <ListSection footer={error ? <Status tone="bad">{error}</Status> : kindNote}>
            <IosFieldRow label="Name">
              <IosTextField value={name} onChange={setName} placeholder="Required" maxLength={40} />
            </IosFieldRow>
            {editing ? (
              <ListRow title="Kind" detail={editing.kind === "income" ? "Income" : "Spending"} />
            ) : (
              <ListRow control={<IosSegmented label="Kind" options={[{ value: "expense", label: "Spending" }, { value: "income", label: "Income" }]} value={kind} onChange={(v) => setKind(v as "expense" | "income")} />} />
            )}
            <ListRow
              title="Symbol"
              popup={<IosPopUp label="Symbol" options={CATEGORY_ICONS.map((value) => ({ value, label: iconName(value), icon: value }))} value={icon} onChange={(v) => setIcon(v as IconName)} />}
            />
          </ListSection>
        </List>
      </IosSheet>
    );
  }

  return (
    <Sheet
      open={open}
      // Saving closes the sheet only when it succeeds, so a refused name stays with its reason.
      onClose={(button) => (button === "Cancel" || button === undefined ? onClose() : undefined)}
      title={title}
      top={60}
      buttons={[
        { label: "Cancel", role: "cancel" },
        { label: pending ? "Saving…" : editing ? "Save" : "Add", role: "default", disabled: !canSave, onClick: save },
      ]}
    >
      <FieldGrid
        rows={[
          { label: "Name:", control: <TextField value={name} onChange={setName} placeholder="Subscriptions" maxLength={40} autoFocus /> },
          {
            label: "Kind:",
            control: editing ? (
              <FormValue>{editing.kind === "income" ? "Income" : "Spending"}</FormValue>
            ) : (
              <SegmentedControl label="Kind" options={[{ value: "expense", label: "Spending" }, { value: "income", label: "Income" }]} value={kind} onChange={(v) => setKind(v as "expense" | "income")} />
            ),
            note: kindNote,
          },
          {
            label: "Symbol:",
            control: (
              <Button
                icon={icon}
                menu={
                  <>
                    {CATEGORY_ICONS.map((value) => (
                      <MenuItem key={value} icon={value} checked={value === icon} onSelect={() => setIcon(value)}>
                        {iconName(value)}
                      </MenuItem>
                    ))}
                  </>
                }
              >
                {iconName(icon)}
              </Button>
            ),
            ...(error ? { note: error, error: true } : {}),
          },
        ]}
      />
    </Sheet>
  );
}

function BudgetSheet({ open, category, currency, onClose }: { open: boolean; category: CategoryItem | null; currency: string; onClose: () => void }) {
  const phone = usePhone();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = useAction();
  useEffect(() => {
    if (!open) return;
    setAmount(category?.budget ? plainAmount(category.budget.limit) : "");
    setError(null);
  }, [open, category?.id, category?.budget?.limit.minor]);

  const save = (value: string) => {
    if (!category || pending) return;
    setError(null);
    run(setBudgetAction, { categoryId: category.id, amount: value.trim() }, (result) => (result.error ? setError(result.error) : onClose()));
  };
  const hint = category?.suggestion
    ? `You spent about ${money(category.suggestion.average)} a month over the last three months. ${money(category.suggestion.suggested)} is a round limit just above that.`
    : `A monthly limit in ${currency}. Nothing here moves money; it is compared with what you record.`;
  const title = category ? `${category.name} Budget` : "Budget";

  if (phone) {
    return (
      <IosSheet
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title={title}
        detents={["medium", "large"]}
        leading={<IosButton variant="glass" onClick={onClose}>Cancel</IosButton>}
        trailing={
          <IosButton variant="glass-prominent" disabled={pending || amount.trim() === ""} onClick={() => save(amount)}>
            {pending ? "Saving…" : "Save"}
          </IosButton>
        }
      >
        <List>
          <ListSection footer={error ? <Status tone="bad">{error}</Status> : hint}>
            <IosFieldRow label="Each month">
              <IosTextField value={amount} onChange={setAmount} placeholder="0.00" inputMode="decimal" />
            </IosFieldRow>
            {category?.suggestion ? (
              <ListRow title={`Use ${money(category.suggestion.suggested)}`} action onClick={() => setAmount(plainAmount(category.suggestion!.suggested))} />
            ) : null}
          </ListSection>
          {category?.budget ? (
            <ListSection>
              <ListRow title="Remove Budget" action destructive disabled={pending} onClick={() => save("")} />
            </ListSection>
          ) : null}
        </List>
      </IosSheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={(button) => (button === "Cancel" || button === undefined ? onClose() : undefined)}
      title={title}
      top={60}
      buttons={[
        ...(category?.budget ? [{ label: "Remove Budget", role: "leading" as const, disabled: pending, onClick: () => save("") }] : []),
        { label: "Cancel", role: "cancel" },
        { label: pending ? "Saving…" : "Save", role: "default", disabled: pending || amount.trim() === "", onClick: () => save(amount) },
      ]}
    >
      <FieldGrid
        rows={[
          {
            label: "Each month:",
            control: <TextField value={amount} onChange={setAmount} placeholder={`0.00 ${currency}`} inputMode="decimal" autoFocus />,
            note: error ?? hint,
            ...(error ? { error: true } : {}),
          },
          ...(category?.suggestion
            ? [{ label: "", control: <Button size="small" onClick={() => setAmount(plainAmount(category.suggestion!.suggested))}>Use {money(category.suggestion.suggested)}</Button> }]
            : []),
        ]}
      />
    </Sheet>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* macOS                                                                                        */
/* ------------------------------------------------------------------------------------------ */

function MacCategories({ data }: { data: CategoriesData }) {
  const router = useRouter();
  const spending = data.categories.filter((c) => !c.archived && c.kind === "expense");
  const income = data.categories.filter((c) => !c.archived && c.kind === "income");
  const archived = data.categories.filter((c) => c.archived);
  const [selectedId, setSelectedId] = useState<string | null>(spending[0]?.id ?? income[0]?.id ?? null);
  const selected = data.categories.find((c) => c.id === selectedId) ?? null;
  const [inspector, setInspector] = useState(true);
  const [sheet, setSheet] = useState<"new" | "edit" | "budget" | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const { pending, run } = useAction();

  const report = (result: CategoryState) => setNotice(result.error ? { tone: "bad", text: result.error } : result.ok ? { tone: "good", text: result.ok } : null);
  const canArchive = selected !== null && (selected.archived || !selected.protected);
  const archiveOrRestore = () => {
    if (!selected || !canArchive) return;
    if (selected.archived) run(setCategoryArchivedAction, { id: selected.id, archived: "true" }, report);
    else setConfirmArchive(true);
  };
  const showTransactions = (category: CategoryItem) => router.push(`/transactions?category=${encodeURIComponent(category.id)}` as Route);

  const base: TableColumn<CategoryItem>[] = [
    { key: "name", title: "Category" },
    { key: "uses", title: "Uses", width: 70, numeric: true },
    { key: "thisMonth", title: data.monthLabel, width: 150, numeric: true, sortValue: (c) => Number(c.thisMonth.minor), render: (c) => money(c.thisMonth) },
  ];
  const spendingColumns: TableColumn<CategoryItem>[] = [
    ...base,
    { key: "budget", title: "Budget", width: 150, numeric: true, sortValue: (c) => Number(c.budget?.limit.minor ?? -1n), render: (c) => (c.budget ? money(c.budget.limit) : "--") },
    {
      key: "used",
      title: "Used",
      width: 170,
      sortValue: (c) => c.budget?.ratio ?? -1,
      render: (c) => {
        if (!c.budget) return "--";
        const status = budgetStatus(c.budget);
        return <Status tone={status.tone}>{status.text}</Status>;
      },
    },
  ];
  const archivedColumns: TableColumn<CategoryItem>[] = [
    { key: "name", title: "Category" },
    { key: "kind", title: "Kind", width: 110, render: (c) => (c.kind === "income" ? "Income" : "Spending") },
    { key: "uses", title: "Uses", width: 70, numeric: true },
  ];

  const menu = (
    <>
      <MenuItem icon="pencil" disabled={!selected} onSelect={() => setSheet("edit")}>Edit…</MenuItem>
      <MenuItem icon="chart-bar" disabled={!selected || selected.kind !== "expense" || selected.archived} onSelect={() => setSheet("budget")}>Set Budget…</MenuItem>
      <MenuItem icon="list-bullet" disabled={!selected} onSelect={() => selected && showTransactions(selected)}>Show Transactions</MenuItem>
      <MenuSeparator />
      <MenuItem icon={selected?.archived ? "arrow-uturn-left" : "archivebox"} disabled={!canArchive} onSelect={archiveOrRestore}>
        {selected?.archived ? "Restore" : "Archive…"}
      </MenuItem>
    </>
  );

  const table = (rows: CategoryItem[], columns: TableColumn<CategoryItem>[], label: string, empty: string) => (
    <Tile flush>
      <ContextMenu menu={menu}>
        <Table
          label={label}
          columns={columns}
          rows={rows}
          rowIcon={(c) => c.icon}
          selection={selectedId ? [selectedId] : []}
          onSelectionChange={(ids) => {
            setSelectedId(ids[0] === undefined ? null : String(ids[0]));
            setNotice(null);
          }}
          onRowAction={() => setSheet("edit")}
          emptyText={empty}
        />
      </ContextMenu>
    </Tile>
  );

  return (
    <MacPage
      title="Categories"
      subtitle={`${spending.length} spending · ${income.length} income`}
      toolbar={
        <>
          <ToolbarButton icon="plus" label="New Category" onClick={() => setSheet("new")} />
          <ToolbarButton icon="pencil" label="Edit Category" disabled={!selected} onClick={() => setSheet("edit")} />
          <ToolbarButton icon="chart-bar" label="Set Budget" disabled={!selected || selected.kind !== "expense" || selected.archived} onClick={() => setSheet("budget")} />
          <ToolbarButton
            icon={selected?.archived ? "arrow-uturn-left" : "archivebox"}
            label={selected?.archived ? "Restore Category" : "Archive Category"}
            disabled={!canArchive || pending}
            onClick={archiveOrRestore}
          />
          <ToolbarButton icon="sidebar-right" label={inspector ? "Hide Inspector" : "Show Inspector"} pressed={inspector} onClick={() => setInspector((on) => !on)} />
        </>
      }
      body={
        <WindowBody>
          <Content>
            <Stack>
              <Section title="Spending" footer={`${data.monthLabel}, in ${data.currency}. A budget is a monthly limit compared with what you record; it never moves money.`}>
                {table(spending, spendingColumns, "Spending categories", "No spending categories.")}
              </Section>
              <Section title="Income">{table(income, base, "Income categories", "No income categories yet. Add one such as Salary.")}</Section>
              {archived.length > 0 ? (
                <Section title="Archived" footer="Archived categories leave the pickers. Every record filed under one still shows it.">
                  {table(archived, archivedColumns, "Archived categories", "None")}
                </Section>
              ) : null}
            </Stack>
          </Content>

          <Inspector hidden={!inspector} width={300}>
            {selected ? (
              <Form>
                <FormSection title={selected.name} footer={notice ? <Status tone={notice.tone}>{notice.text}</Status> : undefined}>
                  <FormRow label="Symbol"><FormValue><KitIcon name={selected.icon} /> {iconName(selected.icon)}</FormValue></FormRow>
                  <FormRow label="Kind"><FormValue>{selected.kind === "income" ? "Income" : "Spending"}</FormValue></FormRow>
                  <FormRow label="Uses"><FormValue>{plural(selected.uses, "record")}</FormValue></FormRow>
                  <FormRow label={selected.kind === "income" ? "Received" : "Spent"} subtitle={data.monthLabel}><FormValue>{money(selected.thisMonth)}</FormValue></FormRow>
                  <FormRow label="Status"><FormValue>{selected.archived ? "Archived" : "In use"}</FormValue></FormRow>
                </FormSection>
                {selected.kind === "expense" && !selected.archived ? (
                  <FormSection
                    title="Monthly budget"
                    footer={
                      selected.budget
                        ? `At this month's pace it ends near ${money(selected.budget.projected)}.`
                        : selected.suggestion
                          ? `About ${money(selected.suggestion.average)} a month lately; ${money(selected.suggestion.suggested)} would be a round limit.`
                          : "No budget set."
                    }
                  >
                    <FormRow label="Limit"><FormValue>{selected.budget ? money(selected.budget.limit) : "None"}</FormValue></FormRow>
                    {selected.budget ? (
                      <>
                        <FormRow label="Used">
                          {/* A form row's control sizes to its content, which collapses a bar; give it a width (placement only). */}
                          <span style={{ display: "inline-block", width: 140 }}>
                            <ProgressBar value={Math.min(100, Math.round(selected.budget.ratio * 100))} label={`${selected.name} budget used`} />
                          </span>
                        </FormRow>
                        <FormRow label="Status"><FormValue><Status tone={budgetStatus(selected.budget).tone}>{budgetStatus(selected.budget).text}</Status></FormValue></FormRow>
                      </>
                    ) : null}
                    <FormRow label="Budget"><Button size="small" onClick={() => setSheet("budget")}>{selected.budget ? "Change…" : "Set…"}</Button></FormRow>
                  </FormSection>
                ) : null}
                <FormSection footer={!selected.archived && selected.protected ? PROTECTED_REASON : undefined}>
                  <FormRow label="Details"><Button size="small" onClick={() => setSheet("edit")}>Edit…</Button></FormRow>
                  <FormRow label="Transactions"><Button size="small" onClick={() => showTransactions(selected)}>Show</Button></FormRow>
                  <FormRow label={selected.archived ? "Archived" : "Archive"}>
                    <Button size="small" disabled={!canArchive || pending} onClick={archiveOrRestore}>{selected.archived ? "Restore" : "Archive…"}</Button>
                  </FormRow>
                </FormSection>
              </Form>
            ) : (
              <EmptyState title="No Selection" message="Select a category to see its details and budget." />
            )}
          </Inspector>

          <CategorySheet open={sheet === "new" || sheet === "edit"} editing={sheet === "edit" ? selected : null} onClose={() => setSheet(null)} />
          <BudgetSheet open={sheet === "budget"} category={selected} currency={data.currency} onClose={() => setSheet(null)} />

          <Alert
            open={confirmArchive && selected !== null}
            onClose={() => setConfirmArchive(false)}
            title={`Archive “${selected?.name ?? ""}”?`}
            message="It leaves the pickers, and its budget is removed. Every record filed under it keeps it, and you can restore it at any time."
            buttons={[
              { label: "Archive", role: "default", onClick: () => selected && run(setCategoryArchivedAction, { id: selected.id, archived: "false" }, report) },
              { label: "Cancel", role: "cancel" },
            ]}
          />
        </WindowBody>
      }
    />
  );
}

/* ------------------------------------------------------------------------------------------ */
/* iOS                                                                                          */
/* ------------------------------------------------------------------------------------------ */

function IosCategories({ data }: { data: CategoriesData }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const open = data.categories.find((c) => c.id === openId);
  if (open) return <IosCategoryScreen key={open.id} data={data} category={open} onBack={() => setOpenId(null)} />;

  const spending = data.categories.filter((c) => !c.archived && c.kind === "expense");
  const income = data.categories.filter((c) => !c.archived && c.kind === "income");
  const archived = data.categories.filter((c) => c.archived);

  const row = (category: CategoryItem) => {
    const parts = [plural(category.uses, "use")];
    if (category.budget) parts.push(`${Math.round(category.budget.ratio * 100)}% of ${money(category.budget.limit)}`);
    return (
      <ListRow
        key={category.id}
        title={category.name}
        subtitle={parts.join(" · ")}
        detail={category.archived ? undefined : money(category.thisMonth, { withCode: false })}
        icon={category.icon}
        iconColor={category.archived ? "gray" : category.color}
        onClick={() => setOpenId(category.id)}
      />
    );
  };

  return (
    <IosPage title="Categories" back={{ label: "Home", href: "/" }} trailing={<BarButton icon="plus" label="New Category" onClick={() => setCreating(true)} />}>
      <List>
        <ListSection header="Spending" footer={`Amounts are ${data.monthLabel}, in ${data.currency}.`}>{spending.map(row)}</ListSection>
        <ListSection header="Income" footer={income.length <= 1 ? "Add income categories such as Salary or Interest to see where money comes from." : undefined}>
          {income.map(row)}
        </ListSection>
        {archived.length > 0 ? (
          <ListSection header="Archived" footer="Archived categories leave the pickers. Every record filed under one still shows it.">
            {archived.map(row)}
          </ListSection>
        ) : null}
      </List>
      <CategorySheet open={creating} editing={null} onClose={() => setCreating(false)} />
    </IosPage>
  );
}

function IosCategoryScreen({ data, category, onBack }: { data: CategoriesData; category: CategoryItem; onBack: () => void }) {
  const [sheet, setSheet] = useState<"edit" | "budget" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const { pending, run } = useAction();
  const report = (result: CategoryState) => setNotice(result.error ? { tone: "bad", text: result.error } : result.ok ? { tone: "good", text: result.ok } : null);
  const status = category.budget ? budgetStatus(category.budget) : null;

  return (
    <IosPage title={category.name} back={{ label: "Categories", onBack }} trailing={<BarButton onClick={() => setSheet("edit")}>Edit</BarButton>}>
      <List>
        <ListSection>
          <ListRow title="Kind" detail={category.kind === "income" ? "Income" : "Spending"} icon={category.icon} iconColor={category.archived ? "gray" : category.color} />
          <ListRow title="Uses" detail={plural(category.uses, "record")} />
          <ListRow title={category.kind === "income" ? `Received in ${data.monthLabel}` : `Spent in ${data.monthLabel}`} detail={money(category.thisMonth)} />
        </ListSection>

        {category.kind === "expense" && !category.archived ? (
          <ListSection
            header="Monthly Budget"
            footer={
              category.budget
                ? `At this month's pace it ends near ${money(category.budget.projected)}. Nothing here moves money.`
                : category.suggestion
                  ? `About ${money(category.suggestion.average)} a month lately; ${money(category.suggestion.suggested)} would be a round limit.`
                  : "A monthly limit, compared with what you record. Nothing here moves money."
            }
          >
            <ListRow title="Limit" detail={category.budget ? money(category.budget.limit) : "None"} onClick={() => setSheet("budget")} />
            {category.budget && status ? (
              <>
                <ListRow control={<IosProgress value={Math.min(1, category.budget.ratio)} label={`${money(category.budget.spent)} of ${money(category.budget.limit)}`} />} />
                <ListRow title="Status" detail={<Status tone={status.tone}>{status.text}</Status>} />
              </>
            ) : null}
          </ListSection>
        ) : null}

        <ListSection>
          <ListRow title="Show Transactions" href={`/transactions?category=${encodeURIComponent(category.id)}`} />
        </ListSection>

        <ListSection footer={notice ? <Status tone={notice.tone}>{notice.text}</Status> : !category.archived && category.protected ? PROTECTED_REASON : undefined}>
          {category.archived ? (
            <ListRow title="Restore Category" action disabled={pending} onClick={() => run(setCategoryArchivedAction, { id: category.id, archived: "true" }, report)} />
          ) : (
            <ListRow title="Archive Category" action destructive disabled={pending || category.protected} onClick={() => setConfirm(true)} />
          )}
        </ListSection>
      </List>

      <CategorySheet open={sheet === "edit"} editing={category} onClose={() => setSheet(null)} />
      <BudgetSheet open={sheet === "budget"} category={category} currency={data.currency} onClose={() => setSheet(null)} />
      <ActionSheet
        open={confirm}
        onOpenChange={setConfirm}
        title={`Archive “${category.name}”?`}
        message="It leaves the pickers, and its budget is removed. Every record filed under it keeps it."
        actions={[
          { label: "Archive Category", role: "destructive", onPress: () => run(setCategoryArchivedAction, { id: category.id, archived: "false" }, report) },
          { label: "Cancel", role: "cancel" },
        ]}
      />
    </IosPage>
  );
}
