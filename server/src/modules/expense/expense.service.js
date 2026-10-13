import prisma from "../../utils/prisma.js";
import { ApiError } from "../../utils/apiError.js";
import notificationService from "../notification/notification.service.js";
import {
  assertCanApprove, assertCanPay, assertCanView, assertCanEdit,
  canViewAll, isSelfApproving, APPROVER_ROLES,
} from "./expense.permission.js";

const EXPENSE_INCLUDE = {
  category: { select: { id: true, name: true, icon: true, fieldSchema: true, isReimbursable: true } },
  submittedBy: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
  reviewedBy: { select: { id: true, firstName: true, lastName: true } },
  paidBy: { select: { id: true, firstName: true, lastName: true } },
  project: { select: { id: true, name: true } },
  client: { select: { id: true, companyName: true } },
  events: {
    orderBy: { createdAt: "desc" },
    include: { actor: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } } },
  },
};

const num = (v) => Number(v || 0);

/**
 * Sequential, human-readable reference: EXP-2026-0001.
 * Scoped per calendar year so numbers stay short.
 */
async function nextReference(tx) {
  const year = new Date().getFullYear();
  const prefix = `EXP-${year}-`;
  const last = await tx.expense.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: "desc" },
    select: { reference: true },
  });
  const seq = last ? parseInt(last.reference.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

/**
 * Check a claim's answers against its category's field schema.
 * The schema is admin-authored, so this is the only place it is enforced.
 */
function validateFormData(category, formData, attachments) {
  const fields = Array.isArray(category.fieldSchema) ? category.fieldSchema : [];
  const data = formData || {};
  const missing = [];

  for (const f of fields) {
    if (!f.required) continue;
    const v = data[f.id];
    if (v === undefined || v === null || String(v).trim() === "") missing.push(f.label);
  }
  if (missing.length > 0) {
    throw ApiError.badRequest(`Missing required details: ${missing.join(", ")}`);
  }

  for (const f of fields) {
    const v = data[f.id];
    if (v === undefined || v === null || v === "") continue;
    if (f.type === "number" && Number.isNaN(Number(v))) {
      throw ApiError.badRequest(`${f.label} must be a number`);
    }
    if (f.type === "select" && Array.isArray(f.options) && !f.options.includes(String(v))) {
      throw ApiError.badRequest(`${f.label} must be one of: ${f.options.join(", ")}`);
    }
  }

  if (category.requiresReceipt && (!attachments || attachments.length === 0)) {
    throw ApiError.badRequest(`${category.name} claims need at least one receipt attached`);
  }
}

// Billable day/month used to convert elapsed working time into the unit a task
// rate is quoted in. Must match TaskTimings.jsx on the client or the two
// screens will disagree about the same task.
const HOURS_PER_DAY = 8;
const HOURS_PER_MONTH = HOURS_PER_DAY * 22;

/**
 * Cost of one task: its internal rate × the time spent working on it.
 *
 * Work starts at the first move to IN_PROGRESS — there is no startedAt column,
 * so the feedback trail is the record. An unfinished task is costed up to now.
 *
 * @returns {{cost: number, hours: number, startedAt: Date|null, at: Date|null}}
 */
export function costOfTask(task) {
  const rate = num(task.internalCostAmount);
  const type = task.internalCostType;
  if (!rate || !type || type === "NONE") {
    return { cost: 0, hours: 0, startedAt: null, at: task.completedAt || null };
  }

  const startedAt = (task.feedbacks || [])
    .filter((f) => f.statusAfter === "IN_PROGRESS")
    .map((f) => new Date(f.createdAt))
    .sort((a, b) => a - b)[0] || null;

  if (!startedAt) return { cost: 0, hours: 0, startedAt: null, at: task.completedAt || null };

  const end = task.completedAt ? new Date(task.completedAt) : new Date();
  const hours = Math.max(0, (end - startedAt) / 3600000);
  const divisor = type === "HOUR" ? 1 : type === "DAY" ? HOURS_PER_DAY : HOURS_PER_MONTH;

  return {
    cost: rate * (hours / divisor),
    hours,
    startedAt,
    // Costs land in the period the work finished, or started if still running.
    at: task.completedAt ? new Date(task.completedAt) : startedAt,
  };
}

/** Months in one billing cycle. ONE_TIME has no cycle. */
const CYCLE_MONTHS = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 };

/**
 * Slice a project's spend into billing periods.
 *
 * Periods run from the project's start date in steps of the billing cycle, so
 * they line up with what the client is actually invoiced for. A one-time
 * project gets a single lifetime bucket.
 *
 * @returns {Array<{label, from, to, amount, count, isCurrent}>} oldest first
 */
function buildBillingPeriods(project, expenses, taskCosts = []) {
  const months = CYCLE_MONTHS[project.billingCycle];
  const start = project.startDate ? new Date(project.startDate) : null;

  if (!months || !start) {
    const amount = expenses.reduce((sum, e) => sum + num(e.totalAmount), 0);
    const taskAmount = taskCosts.reduce((sum, t) => sum + t.cost, 0);
    return [{
      label: "Lifetime",
      from: start,
      to: null,
      amount,
      taskAmount,
      total: amount + taskAmount,
      count: expenses.length,
      isCurrent: true,
    }];
  }

  const now = new Date();
  const fmt = (d) => d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
  const periods = [];

  let from = new Date(start);
  // Stop once the window that contains today has been added.
  while (from <= now) {
    const to = new Date(from);
    to.setMonth(to.getMonth() + months);

    const inPeriod = expenses.filter((e) => {
      const d = new Date(e.expenseDate);
      return d >= from && d < to;
    });
    const tasksInPeriod = taskCosts.filter((t) => t.at && t.at >= from && t.at < to);

    const end = new Date(to);
    end.setDate(end.getDate() - 1);

    const amount = inPeriod.reduce((sum, e) => sum + num(e.totalAmount), 0);
    const taskAmount = tasksInPeriod.reduce((sum, t) => sum + t.cost, 0);

    periods.push({
      label: months === 1 ? fmt(from) : `${fmt(from)} – ${fmt(end)}`,
      from: new Date(from),
      to: end,
      amount,
      taskAmount,
      total: amount + taskAmount,
      count: inPeriod.length,
      isCurrent: now >= from && now < to,
    });

    from = to;
  }

  // Long-running retainers would return dozens of periods; the recent ones are
  // what anyone actually looks at.
  return periods.slice(-12);
}

class ExpenseService {
  // ─── Categories ──────────────────────────────────────

  async listCategories({ includeInactive = false } = {}) {
    return prisma.expenseCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
  }

  async createCategory(data) {
    return prisma.expenseCategory.create({ data });
  }

  async updateCategory(id, data) {
    const existing = await prisma.expenseCategory.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Category not found");
    return prisma.expenseCategory.update({ where: { id }, data });
  }

  /** Categories in use are deactivated, never deleted — history must survive. */
  async removeCategory(id) {
    const used = await prisma.expense.count({ where: { categoryId: id } });
    if (used > 0) {
      return prisma.expenseCategory.update({ where: { id }, data: { isActive: false } });
    }
    await prisma.expenseCategory.delete({ where: { id } });
    return null;
  }

  // ─── Expenses ────────────────────────────────────────

  async create(data, user) {
    const category = await prisma.expenseCategory.findUnique({ where: { id: data.categoryId } });
    if (!category || !category.isActive) throw ApiError.badRequest("Category not found");

    const wantsDraft = data.status === "DRAFT";
    if (!wantsDraft) validateFormData(category, data.formData, data.attachments);

    // Owners and admins record spend directly; everyone else files a claim.
    const status = wantsDraft ? "DRAFT" : isSelfApproving(user) ? "APPROVED" : "PENDING";

    const amount = num(data.amount);
    const taxAmount = num(data.taxAmount);

    const expense = await prisma.$transaction(async (tx) => {
      const created = await tx.expense.create({
        data: {
          reference: await nextReference(tx),
          title: data.title,
          description: data.description || null,
          categoryId: category.id,
          formData: data.formData ?? {},
          attachments: data.attachments ?? [],
          amount,
          taxAmount,
          totalAmount: amount + taxAmount,
          expenseDate: new Date(data.expenseDate),
          isReimbursable: data.isReimbursable ?? category.isReimbursable,
          paymentMode: data.paymentMode || null,
          projectId: data.projectId || null,
          clientId: data.clientId || null,
          isBillable: !!data.isBillable,
          status,
          submittedById: user.id,
          // Self-approved spend records its own approval so the trail is complete.
          ...(status === "APPROVED"
            ? { reviewedById: user.id, reviewedAt: new Date() }
            : {}),
        },
      });

      await tx.expenseEvent.create({
        data: {
          expenseId: created.id,
          action: status === "APPROVED" ? "APPROVED" : status === "DRAFT" ? "EDITED" : "SUBMITTED",
          note: status === "APPROVED" ? "Recorded directly" : null,
          statusAfter: status,
          actorId: user.id,
        },
      });

      return tx.expense.findUnique({ where: { id: created.id }, include: EXPENSE_INCLUDE });
    });

    if (status === "PENDING") {
      this.#notifyApprovers(expense).catch((e) =>
        console.error("[ExpenseService] approver notify failed:", e.message)
      );
    }

    return expense;
  }

  async list(filters, user) {
    const {
      page = 1, limit = 20, status, categoryId, projectId, userId,
      isBillable, dateFrom, dateTo, search,
    } = filters;

    const where = {};

    // Anyone who is not an approver or finance only ever sees their own claims.
    if (!canViewAll(user)) where.submittedById = user.id;
    else if (userId) where.submittedById = userId;

    if (status) where.status = status;
    if (categoryId) where.categoryId = categoryId;
    if (projectId) where.projectId = projectId;
    if (isBillable !== undefined && isBillable !== "") where.isBillable = isBillable === "true";

    if (dateFrom || dateTo) {
      where.expenseDate = {};
      if (dateFrom) where.expenseDate.gte = new Date(dateFrom);
      if (dateTo) where.expenseDate.lte = new Date(dateTo);
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { reference: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    const [expenses, total, sums] = await Promise.all([
      prisma.expense.findMany({
        where,
        include: EXPENSE_INCLUDE,
        orderBy: { expenseDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.expense.count({ where }),
      prisma.expense.aggregate({ where, _sum: { totalAmount: true } }),
    ]);

    return {
      expenses,
      totalAmount: num(sums._sum.totalAmount),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getById(id, user) {
    const expense = await prisma.expense.findUnique({ where: { id }, include: EXPENSE_INCLUDE });
    if (!expense) throw ApiError.notFound("Expense not found");
    assertCanView(user, expense);
    return expense;
  }

  async update(id, data, user) {
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Expense not found");
    assertCanEdit(user, existing);

    const categoryId = data.categoryId || existing.categoryId;
    const category = await prisma.expenseCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw ApiError.badRequest("Category not found");

    const patch = {};
    for (const k of [
      "title", "description", "paymentMode", "projectId", "clientId",
      "isBillable", "isReimbursable", "formData", "attachments",
    ]) {
      if (data[k] !== undefined) patch[k] = data[k] === "" ? null : data[k];
    }
    if (data.categoryId !== undefined) patch.categoryId = categoryId;
    if (data.expenseDate !== undefined) patch.expenseDate = new Date(data.expenseDate);

    if (data.amount !== undefined || data.taxAmount !== undefined) {
      const amount = data.amount !== undefined ? num(data.amount) : num(existing.amount);
      const taxAmount = data.taxAmount !== undefined ? num(data.taxAmount) : num(existing.taxAmount);
      patch.amount = amount;
      patch.taxAmount = taxAmount;
      patch.totalAmount = amount + taxAmount;
    }

    // Correcting a rejected claim puts it back in the queue.
    const resubmitting = existing.status === "REJECTED" && data.status !== "DRAFT";
    if (resubmitting) {
      validateFormData(category, patch.formData ?? existing.formData, patch.attachments ?? existing.attachments);
      patch.status = "PENDING";
      patch.reviewedById = null;
      patch.reviewedAt = null;
      patch.reviewNotes = null;
    } else if (data.status === "PENDING" && existing.status === "DRAFT") {
      validateFormData(category, patch.formData ?? existing.formData, patch.attachments ?? existing.attachments);
      patch.status = isSelfApproving(user) ? "APPROVED" : "PENDING";
      if (patch.status === "APPROVED") {
        patch.reviewedById = user.id;
        patch.reviewedAt = new Date();
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.expense.update({ where: { id }, data: patch });
      await tx.expenseEvent.create({
        data: {
          expenseId: id,
          action: patch.status && patch.status !== existing.status ? "SUBMITTED" : "EDITED",
          statusAfter: patch.status || existing.status,
          actorId: user.id,
        },
      });
      return tx.expense.findUnique({ where: { id }, include: EXPENSE_INCLUDE });
    });

    if (updated.status === "PENDING" && existing.status !== "PENDING") {
      this.#notifyApprovers(updated).catch(() => {});
    }

    return updated;
  }

  /** Approve, reject, cancel and pay all funnel through one transition. */
  async #transition(id, { action, statusAfter, note, extra = {} }, user) {
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Expense not found");

    const updated = await prisma.$transaction(async (tx) => {
      await tx.expense.update({ where: { id }, data: { status: statusAfter, ...extra } });
      await tx.expenseEvent.create({
        data: { expenseId: id, action, note: note || null, statusAfter, actorId: user.id },
      });
      return tx.expense.findUnique({ where: { id }, include: EXPENSE_INCLUDE });
    });

    this.#notifyClaimant(updated, action).catch(() => {});
    return updated;
  }

  async approve(id, note, user) {
    assertCanApprove(user);
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Expense not found");
    if (existing.status !== "PENDING") {
      throw ApiError.badRequest(`Only a pending expense can be approved — this one is ${existing.status}`);
    }
    return this.#transition(id, {
      action: "APPROVED",
      statusAfter: "APPROVED",
      note,
      extra: { reviewedById: user.id, reviewedAt: new Date(), reviewNotes: note || null },
    }, user);
  }

  async reject(id, note, user) {
    assertCanApprove(user);
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Expense not found");
    if (!["PENDING", "APPROVED"].includes(existing.status)) {
      throw ApiError.badRequest(`A ${existing.status} expense cannot be rejected`);
    }
    return this.#transition(id, {
      action: "REJECTED",
      statusAfter: "REJECTED",
      note,
      extra: { reviewedById: user.id, reviewedAt: new Date(), reviewNotes: note },
    }, user);
  }

  async pay(id, { paymentMode, paymentRef, paidAt, note }, user) {
    assertCanPay(user);
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Expense not found");
    if (existing.status !== "APPROVED") {
      throw ApiError.badRequest("Only an approved expense can be marked paid");
    }
    return this.#transition(id, {
      action: "PAID",
      statusAfter: "PAID",
      note,
      extra: {
        paidById: user.id,
        paidAt: paidAt ? new Date(paidAt) : new Date(),
        paymentMode: paymentMode || existing.paymentMode,
        paymentRef: paymentRef || null,
      },
    }, user);
  }

  async cancel(id, user) {
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Expense not found");
    if (existing.submittedById !== user.id && !APPROVER_ROLES.includes(user.role)) {
      throw ApiError.forbidden("Only the claimant can withdraw this expense");
    }
    if (["PAID", "CANCELLED"].includes(existing.status)) {
      throw ApiError.badRequest(`A ${existing.status} expense cannot be withdrawn`);
    }
    return this.#transition(id, { action: "CANCELLED", statusAfter: "CANCELLED" }, user);
  }

  async remove(id, user) {
    const existing = await prisma.expense.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Expense not found");
    if (user.role !== "OWNER") throw ApiError.forbidden("Only an owner can delete an expense");
    if (existing.status === "PAID") throw ApiError.badRequest("A settled expense cannot be deleted");
    await prisma.expense.delete({ where: { id } });
  }

  /**
   * Dashboard figures, shaped by who is asking.
   *
   * Approvers get the queue, payers get the liability, everyone gets their own
   * position. Project-attributed spend is money-wide, so it is limited to the
   * roles that see company finances.
   */
  async getStats(user) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const approver = APPROVER_ROLES.includes(user.role);
    const financeWide = canViewAll(user);

    const [
      pendingQueue,
      owedToStaff,
      myPending,
      myPaidThisMonth,
      monthSpend,
      projectSpend,
      recent,
    ] = await Promise.all([
      // Awaiting approval — company-wide for approvers, otherwise skipped.
      approver
        ? prisma.expense.aggregate({
            where: { status: "PENDING" },
            _count: { id: true },
            _sum: { totalAmount: true },
          })
        : null,

      // Approved, reimbursable, not yet paid — a real liability.
      financeWide
        ? prisma.expense.aggregate({
            where: { status: "APPROVED", isReimbursable: true },
            _count: { id: true },
            _sum: { totalAmount: true },
          })
        : null,

      // What this user is still owed or waiting on.
      prisma.expense.aggregate({
        where: {
          submittedById: user.id,
          status: { in: ["PENDING", "APPROVED"] },
          isReimbursable: true,
        },
        _count: { id: true },
        _sum: { totalAmount: true },
      }),

      prisma.expense.aggregate({
        where: { submittedById: user.id, status: "PAID", paidAt: { gte: monthStart } },
        _sum: { totalAmount: true },
      }),

      // Company spend this month, approved or settled.
      financeWide
        ? prisma.expense.aggregate({
            where: { status: { in: ["APPROVED", "PAID"] }, expenseDate: { gte: monthStart } },
            _sum: { totalAmount: true },
          })
        : null,

      // Spend attributed to a project, and how much of it is rechargeable.
      financeWide
        ? prisma.expense.groupBy({
            by: ["isBillable"],
            where: { status: { in: ["APPROVED", "PAID"] }, projectId: { not: null } },
            _count: { id: true },
            _sum: { totalAmount: true },
          })
        : null,

      prisma.expense.findMany({
        where: approver ? { status: "PENDING" } : { submittedById: user.id },
        take: 5,
        orderBy: { createdAt: "desc" },
        include: {
          category: { select: { id: true, name: true, icon: true } },
          submittedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    const billableRow = projectSpend?.find((r) => r.isBillable === true);
    const nonBillableRow = projectSpend?.find((r) => r.isBillable === false);

    return {
      canApprove: approver,
      financeWide,
      pendingApproval: approver
        ? { count: pendingQueue._count.id, amount: num(pendingQueue._sum.totalAmount) }
        : null,
      owedToStaff: financeWide
        ? { count: owedToStaff._count.id, amount: num(owedToStaff._sum.totalAmount) }
        : null,
      mine: {
        count: myPending._count.id,
        amount: num(myPending._sum.totalAmount),
        paidThisMonth: num(myPaidThisMonth._sum.totalAmount),
      },
      monthSpend: financeWide ? num(monthSpend._sum.totalAmount) : null,
      projectSpend: financeWide
        ? {
            total: num(billableRow?._sum.totalAmount) + num(nonBillableRow?._sum.totalAmount),
            billable: num(billableRow?._sum.totalAmount),
            billableCount: billableRow?._count.id ?? 0,
          }
        : null,
      recent: recent.map((e) => ({
        ...e,
        amount: num(e.amount),
        totalAmount: num(e.totalAmount),
      })),
    };
  }

  /**
   * Expense summary for one project.
   *
   * A recurring project's lifetime total says little — a two-year retainer will
   * always look expensive. So spend is also broken down by billing period, with
   * the period containing today called out separately.
   */
  async getProjectSummary(projectId) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, billingCycle: true, startDate: true, budget: true },
    });
    if (!project) throw ApiError.notFound("Project not found");

    // Delivery cost sits alongside claimed spend: team time is the larger half
    // of what a project actually costs.
    const [tasks, invoiceAgg] = await Promise.all([
      prisma.task.findMany({
        where: { projectId, internalCostType: { not: "NONE" } },
        select: {
          id: true, title: true, completedAt: true, status: true,
          internalCostAmount: true, internalCostType: true,
          assignee: { select: { id: true, firstName: true, lastName: true } },
          feedbacks: { select: { statusAfter: true, createdAt: true } },
        },
      }),
      // What the client has actually been billed, for margin.
      prisma.invoice.aggregate({
        where: { projectId, status: { notIn: ["DRAFT", "CANCELLED"] }, isActive: true },
        _sum: { total: true, amountPaid: true },
      }),
    ]);

    const taskCosts = tasks.map((t) => ({ task: t, ...costOfTask(t) }));
    const taskCostTotal = taskCosts.reduce((sum, t) => sum + t.cost, 0);
    const taskHours = taskCosts.reduce((sum, t) => sum + t.hours, 0);
    const runningTaskCost = taskCosts
      .filter((t) => !t.task.completedAt && t.cost > 0)
      .reduce((sum, t) => sum + t.cost, 0);

    // Drafts, rejections and withdrawals are not money spent.
    const COUNTED = ["APPROVED", "PAID", "PENDING"];

    const expenses = await prisma.expense.findMany({
      where: { projectId, status: { in: COUNTED } },
      select: {
        id: true, reference: true, title: true, totalAmount: true, status: true,
        expenseDate: true, isBillable: true, invoiceId: true,
        category: { select: { id: true, name: true, icon: true } },
        submittedBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { expenseDate: "desc" },
    });

    const settled = expenses.filter((e) => e.status !== "PENDING");
    const total = settled.reduce((sum, e) => sum + num(e.totalAmount), 0);
    const pending = expenses
      .filter((e) => e.status === "PENDING")
      .reduce((sum, e) => sum + num(e.totalAmount), 0);

    const billable = settled.filter((e) => e.isBillable);
    const billableTotal = billable.reduce((sum, e) => sum + num(e.totalAmount), 0);
    const unbilledTotal = billable
      .filter((e) => !e.invoiceId)
      .reduce((sum, e) => sum + num(e.totalAmount), 0);

    // Spend per category, biggest first.
    const catMap = new Map();
    for (const e of settled) {
      const key = e.category?.id || "none";
      const prev = catMap.get(key) || {
        id: key, name: e.category?.name || "Uncategorised",
        icon: e.category?.icon || null, amount: 0, count: 0,
      };
      prev.amount += num(e.totalAmount);
      prev.count += 1;
      catMap.set(key, prev);
    }
    const byCategory = [...catMap.values()].sort((a, b) => b.amount - a.amount);

    const periods = buildBillingPeriods(project, settled, taskCosts);

    const billed = num(invoiceAgg._sum.total);
    const collected = num(invoiceAgg._sum.amountPaid);
    const totalCost = total + taskCostTotal;

    return {
      project: {
        id: project.id,
        name: project.name,
        billingCycle: project.billingCycle,
        budget: project.budget != null ? num(project.budget) : null,
      },
      total,
      pending,
      billableTotal,
      unbilledTotal,
      count: settled.length,
      byCategory,

      // Team time
      taskCost: {
        total: taskCostTotal,
        hours: Math.round(taskHours * 10) / 10,
        running: runningTaskCost,
        taskCount: taskCosts.filter((t) => t.cost > 0).length,
        top: taskCosts
          .filter((t) => t.cost > 0)
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 5)
          .map((t) => ({
            id: t.task.id,
            title: t.task.title,
            status: t.task.status,
            assignee: t.task.assignee,
            hours: Math.round(t.hours * 10) / 10,
            cost: t.cost,
            running: !t.task.completedAt,
          })),
      },

      // The whole picture: what it cost versus what it earned
      totals: {
        cost: totalCost,
        billed,
        collected,
        margin: billed - totalCost,
        marginPct: billed > 0 ? Math.round(((billed - totalCost) / billed) * 100) : null,
      },
      isRecurring: project.billingCycle !== "ONE_TIME",
      periods,
      currentPeriod: periods.find((p) => p.isCurrent) || null,
      recent: expenses.slice(0, 8).map((e) => ({ ...e, totalAmount: num(e.totalAmount) })),
    };
  }

  // ─── Notifications ───────────────────────────────────

  async #notifyApprovers(expense) {
    const approvers = await prisma.user.findMany({
      where: { status: "ACTIVE", role: { in: APPROVER_ROLES } },
      select: { id: true },
    });
    if (approvers.length === 0) return;

    const who = expense.submittedBy
      ? `${expense.submittedBy.firstName} ${expense.submittedBy.lastName}`
      : "A team member";

    await notificationService.sendBulk({
      userIds: approvers.map((u) => u.id),
      title: `Expense approval needed: ${expense.reference}`,
      description: `${who} submitted "${expense.title}" for ${expense.totalAmount}.`,
      type: "INFO",
      channel: "IN_APP",
    });
  }

  async #notifyClaimant(expense, action) {
    const label = {
      APPROVED: "approved", REJECTED: "rejected",
      PAID: "reimbursed", CANCELLED: "withdrawn",
    }[action];
    if (!label || !expense.submittedById) return;

    await notificationService.sendBulk({
      userIds: [expense.submittedById],
      title: `Expense ${label}: ${expense.reference}`,
      description: `"${expense.title}" was ${label}.${expense.reviewNotes ? ` Note: ${expense.reviewNotes}` : ""}`,
      type: "INFO",
      channel: "IN_APP",
    });
  }
}

export default new ExpenseService();
