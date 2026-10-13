import prisma from "../../utils/prisma.js";
import { ApiError } from "../../utils/apiError.js";
import { costOfTask } from "../expense/expense.service.js";
import { computeDerived } from "../campaign/metricFormula.js";

const num = (v) => Number(v || 0);
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** Content buckets from the audit file, matched against campaign type names. */
const CONTENT_TYPES = ["Reel", "Static", "Carousel", "Story", "Shorts", "Ad Creative"];

/** The six scored areas. Scores are entered by hand; the shape is fixed. */
const AUDIT_AREAS = [
  "Branding consistency",
  "Visual quality",
  "Caption hooks",
  "CTA effectiveness",
  "Posting consistency",
  "Ads creative quality",
];

/** Inclusive month bounds. */
function monthRange(year, month) {
  return {
    from: new Date(year, month - 1, 1),
    to: new Date(year, month, 0, 23, 59, 59, 999),
  };
}

/**
 * Map a campaign type to one of the audit file's content buckets.
 * Anything unrecognised lands in "Ad Creative" when it is a paid platform.
 */
function bucketFor(typeName = "", platform = "") {
  const n = typeName.toLowerCase();
  if (n.includes("reel")) return "Reel";
  if (n.includes("short")) return "Shorts";
  if (n.includes("carousel")) return "Carousel";
  if (n.includes("story")) return "Story";
  if (n.includes("organic") || n.includes("post")) return "Static";
  if (["META", "GOOGLE_ADS", "LINKEDIN"].includes(platform)) return "Ad Creative";
  return "Static";
}

class ReportService {
  /**
   * Build a month's report for a project from live data.
   *
   * Everything derivable is derived; sections the CRM cannot know (growth
   * metrics, audit scores, issues, next-month plan) come back as empty shapes
   * ready for manual entry.
   */
  async buildSnapshot(projectId, year, month) {
    const { from, to } = monthRange(year, month);

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true, name: true, status: true, budget: true, startDate: true, endDate: true,
        billingCycle: true,
        client: {
          select: { id: true, companyName: true, contactName: true, email: true, phone: true, industry: true },
        },
        accountManager: { select: { firstName: true, lastName: true } },
      },
    });
    if (!project) throw ApiError.notFound("Project not found");

    const [campaigns, invoices, payments, expenses, tasks, milestones, steps, deliverables] =
      await Promise.all([
        prisma.campaign.findMany({
          where: { projectId, status: { notIn: ["CANCELLED"] } },
          include: {
            type: { select: { name: true, platform: true, metricSchema: true, derivedMetrics: true } },
            dailyStats: { where: { date: { gte: from, lte: to } }, orderBy: { date: "asc" } },
            leads: { select: { id: true, status: true, deal: { select: { stage: true, value: true } } } },
          },
        }),

        prisma.invoice.findMany({
          where: { projectId, status: { not: "CANCELLED" }, isActive: true, issueDate: { gte: from, lte: to } },
          select: {
            id: true, invoiceNumber: true, status: true, total: true, amountPaid: true,
            issueDate: true, dueDate: true,
          },
          orderBy: { issueDate: "asc" },
        }),

        prisma.invoicePayment.findMany({
          where: { invoice: { projectId, isActive: true }, paidAt: { gte: from, lte: to } },
          select: {
            id: true, amount: true, method: true, paidAt: true, referenceNo: true,
            invoice: { select: { invoiceNumber: true } },
          },
          orderBy: { paidAt: "asc" },
        }),

        prisma.expense.findMany({
          where: {
            projectId,
            status: { in: ["APPROVED", "PAID"] },
            expenseDate: { gte: from, lte: to },
          },
          select: {
            id: true, reference: true, title: true, totalAmount: true, expenseDate: true,
            isBillable: true, category: { select: { name: true } },
          },
          orderBy: { expenseDate: "asc" },
        }),

        prisma.task.findMany({
          where: { projectId },
          select: {
            id: true, title: true, status: true, completedAt: true, createdAt: true, dueDate: true,
            internalCostAmount: true, internalCostType: true,
            assignee: { select: { firstName: true, lastName: true } },
            feedbacks: {
              where: { statusAfter: "IN_PROGRESS" },
              select: { statusAfter: true, createdAt: true },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        }),

        prisma.milestone.findMany({
          where: { projectId },
          select: { id: true, title: true, status: true, dueDate: true },
          orderBy: { dueDate: "asc" },
        }),

        prisma.planningStep.findMany({
          where: { projectId },
          select: { id: true, title: true, status: true },
        }),

        prisma.deliverable.findMany({
          where: { projectId },
          select: {
            id: true, title: true, status: true, isPublished: true, publishedAt: true, createdAt: true,
            feedbacks: { select: { type: true, createdAt: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
      ]);

    // ── 01 Client info ──
    const platforms = [...new Set(campaigns.map((c) => c.type?.platform).filter(Boolean))];
    const hasAds = campaigns.some((c) =>
      ["META", "GOOGLE_ADS", "LINKEDIN"].includes(c.type?.platform)
    );
    const hasOrganic = campaigns.some((c) =>
      ["INSTAGRAM", "YOUTUBE", "SEO", "EMAIL"].includes(c.type?.platform)
    );

    const clientInfo = {
      clientName: project.client?.companyName || "—",
      contactName: project.client?.contactName || null,
      industry: project.client?.industry || null,
      projectName: project.name,
      accountManager: project.accountManager
        ? `${project.accountManager.firstName} ${project.accountManager.lastName}`
        : null,
      platforms: platforms.map((p) => p.replace(/_/g, " ")),
      packageType: hasAds && hasOrganic ? "Hybrid" : hasAds ? "Ads" : hasOrganic ? "Organic" : "—",
      reportingMonth: `${new Date(year, month - 1).toLocaleString("en-IN", { month: "long" })} ${year}`,
    };

    // ── 03 Content performance, bucketed by content type ──
    const buckets = Object.fromEntries(
      CONTENT_TYPES.map((t) => [t, { type: t, count: 0, reach: 0, engagement: 0 }])
    );

    let totalReach = 0;
    let totalEngagement = 0;
    let totalImpressions = 0;
    const contentRows = [];

    for (const c of campaigns) {
      const bucket = bucketFor(c.type?.name, c.type?.platform);
      for (const st of c.dailyStats) {
        const m = st.metrics || {};
        const reach = num(m.reach) || num(m.impressions) || num(m.plays) || num(m.views);
        const engagement =
          num(m.likes) + num(m.comments) + num(m.shares) + num(m.saves) + num(m.reactions);

        buckets[bucket].count += 1;
        buckets[bucket].reach += reach;
        buckets[bucket].engagement += engagement;

        totalReach += reach;
        totalEngagement += engagement;
        totalImpressions += num(m.impressions);

        contentRows.push({
          date: st.date,
          campaign: c.name,
          contentId: c.reference,
          type: bucket,
          reach,
          likes: num(m.likes),
          comments: num(m.comments),
          saves: num(m.saves),
          shares: num(m.shares),
          engagement,
          engagementRate: pct(engagement, reach),
        });
      }
    }

    // ── 05 Ads data ──
    const isWon = (l) => l.deal?.stage === "WON";
    const adsRows = campaigns.map((c) => {
      const spend = c.dailyStats.reduce((s, st) => s + num(st.spend), 0);
      const totals = {};
      for (const st of c.dailyStats) {
        for (const [k, v] of Object.entries(st.metrics || {})) {
          totals[k] = (totals[k] || 0) + (Number(v) || 0);
        }
      }
      const leads = c.leads.length;
      return {
        campaign: c.name,
        reference: c.reference,
        objective: c.objective?.replace(/_/g, " "),
        platform: c.type?.platform?.replace(/_/g, " "),
        dateRange: [
          c.startDate?.toISOString().slice(0, 10),
          c.endDate?.toISOString().slice(0, 10),
        ].filter(Boolean).join(" → "),
        spend,
        reach: num(totals.reach) || num(totals.impressions),
        clicks: num(totals.clicks),
        ctr: pct(num(totals.clicks), num(totals.impressions)),
        leads,
        cpl: leads > 0 ? spend / leads : null,
        won: c.leads.filter(isWon).length,
        revenue: c.leads.reduce((s, l) => s + (isWon(l) ? num(l.deal.value) : 0), 0),
        status: c.status,
        derived: computeDerived(c.type?.derivedMetrics, { ...totals, spend }),
      };
    });

    const adSpend = adsRows.reduce((s, r) => s + r.spend, 0);
    const adLeads = adsRows.reduce((s, r) => s + r.leads, 0);

    // ── Money: the half the spreadsheet never had ──
    const billed = invoices.reduce((s, i) => s + num(i.total), 0);
    const received = payments.reduce((s, p) => s + num(p.amount), 0);
    const outstanding = invoices.reduce((s, i) => s + (num(i.total) - num(i.amountPaid)), 0);
    const expenseTotal = expenses.reduce((s, e) => s + num(e.totalAmount), 0);

    // Team time costed into this month, by completion date.
    const taskCosts = tasks
      .map((t) => ({ task: t, ...costOfTask(t) }))
      .filter((x) => x.cost > 0 && x.at && x.at >= from && x.at <= to);
    const taskCost = taskCosts.reduce((s, x) => s + x.cost, 0);

    const totalCost = expenseTotal + taskCost + adSpend;

    const finance = {
      billed,
      received,
      outstanding,
      cost: { expenses: expenseTotal, taskCost, adSpend, total: totalCost },
      profit: {
        realised: received - totalCost,
        realisedMargin: pct(received - totalCost, received),
        billedProfit: billed - totalCost,
        billedMargin: pct(billed - totalCost, billed),
      },
      invoices: invoices.map((i) => ({
        ...i,
        total: num(i.total),
        amountPaid: num(i.amountPaid),
        due: num(i.total) - num(i.amountPaid),
      })),
      payments: payments.map((p) => ({
        ...p,
        amount: num(p.amount),
        invoiceNumber: p.invoice?.invoiceNumber,
      })),
      expenses: expenses.map((e) => ({ ...e, totalAmount: num(e.totalAmount) })),
      topTaskCosts: taskCosts
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10)
        .map((x) => ({
          title: x.task.title,
          assignee: x.task.assignee ? `${x.task.assignee.firstName} ${x.task.assignee.lastName}` : null,
          hours: Math.round(x.hours * 10) / 10,
          cost: x.cost,
        })),
    };

    // ── Delivery progress ──
    const inMonth = (d) => d && new Date(d) >= from && new Date(d) <= to;
    const delivery = {
      tasks: {
        total: tasks.length,
        completed: tasks.filter((t) => t.status === "COMPLETED").length,
        completedThisMonth: tasks.filter((t) => inMonth(t.completedAt)).length,
        open: tasks.filter((t) => t.status !== "COMPLETED").length,
        overdue: tasks.filter(
          (t) => t.status !== "COMPLETED" && t.dueDate && new Date(t.dueDate) < new Date()
        ).length,
      },
      milestones: milestones.map((m) => ({ ...m })),
      steps: {
        total: steps.length,
        completed: steps.filter((s) => s.status === "COMPLETED").length,
      },
      deliverables: deliverables.map((d) => ({
        title: d.title,
        status: d.status,
        published: d.isPublished,
        publishedAt: d.publishedAt,
        approvals: d.feedbacks.filter((f) => f.type === "APPROVED").length,
        revisions: d.feedbacks.filter((f) => f.type === "CHANGES_REQUESTED").length,
      })),
    };

    // ── 08 Dashboard KPIs ──
    const dashboard = {
      totalContentPieces: contentRows.length,
      totalReach,
      totalImpressions,
      totalEngagement,
      avgEngagementRate: pct(totalEngagement, totalReach),
      adSpend,
      adLeads,
      costPerLead: adLeads > 0 ? adSpend / adLeads : null,
      bestContent: [...contentRows]
        .filter((r) => r.engagementRate !== null)
        .sort((a, b) => b.engagementRate - a.engagementRate)[0] || null,
      contentTypes: Object.values(buckets).filter((b) => b.count > 0),
    };

    return {
      generatedFor: { year, month },
      project: { ...project, budget: num(project.budget) },
      clientInfo,
      contentPerformance: { rows: contentRows, buckets: Object.values(buckets) },
      ads: { rows: adsRows, spend: adSpend, leads: adLeads },
      finance,
      delivery,
      dashboard,

      // Sections the CRM cannot know — shaped and ready for manual entry.
      growthMetrics: [
        { metric: "Followers", start: null, end: null, growth: null, notes: "" },
        { metric: "Profile Visits", start: null, end: null, growth: null, notes: "" },
        { metric: "Website Clicks", start: null, end: null, growth: null, notes: "" },
        { metric: "Calls / WhatsApp Clicks", start: null, end: null, growth: null, notes: "" },
      ],
      auditScore: AUDIT_AREAS.map((area) => ({
        area, score: null, wentWell: "", needsImprovement: "", owner: "",
      })),
      issues: [],
      nextMonthPlan: [],
    };
  }

  /**
   * Generate (or regenerate) a month's report.
   *
   * Regenerating refreshes the snapshot but keeps whatever was entered by hand,
   * so a corrected invoice does not cost the analyst their audit notes.
   */
  async generate(projectId, year, month, userId, { refresh = false } = {}) {
    const existing = await prisma.projectReport.findUnique({
      where: { projectId_periodYear_periodMonth: { projectId, periodYear: year, periodMonth: month } },
      select: { id: true, status: true },
    });

    if (existing && !refresh) return this.getById(existing.id);
    if (existing?.status === "FINAL" && refresh) {
      throw ApiError.badRequest("This report is final. Reopen it before regenerating.");
    }

    const snapshot = await this.buildSnapshot(projectId, year, month);

    const report = existing
      ? await prisma.projectReport.update({
          where: { id: existing.id },
          data: { snapshot, generatedById: userId, generatedAt: new Date() },
        })
      : await prisma.projectReport.create({
          data: {
            projectId,
            periodYear: year,
            periodMonth: month,
            snapshot,
            generatedById: userId,
          },
        });

    return this.getById(report.id);
  }

  async getById(id) {
    const report = await prisma.projectReport.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, client: { select: { companyName: true } } } },
        generatedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!report) throw ApiError.notFound("Report not found");
    return report;
  }

  /** Reports for one project, or across all projects when projectId is omitted. */
  async list({ projectId, year, page = 1, limit = 20 } = {}) {
    const where = {};
    if (projectId) where.projectId = projectId;
    if (year) where.periodYear = Number(year);

    const [items, total] = await Promise.all([
      prisma.projectReport.findMany({
        where,
        select: {
          id: true, periodYear: true, periodMonth: true, status: true,
          generatedAt: true, updatedAt: true,
          project: { select: { id: true, name: true, client: { select: { companyName: true } } } },
          generatedBy: { select: { firstName: true, lastName: true } },
        },
        orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.projectReport.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Apply manual edits. Overrides live beside the snapshot rather than on top of
   * it, so every hand-entered value stays revertible and auditable.
   *
   * @param {object} patch { overrides, summary, status }
   */
  async update(id, patch, userId) {
    const report = await prisma.projectReport.findUnique({
      where: { id },
      select: { id: true, status: true, overrides: true },
    });
    if (!report) throw ApiError.notFound("Report not found");
    if (report.status === "FINAL" && patch.status !== "DRAFT") {
      throw ApiError.badRequest("This report is final. Reopen it to edit.");
    }

    const data = {};
    if (patch.overrides !== undefined) {
      // Merge so a partial save never wipes sections the client did not send.
      data.overrides = { ...(report.overrides || {}), ...patch.overrides };
    }
    if (patch.summary !== undefined) data.summary = patch.summary || null;
    if (patch.status !== undefined) data.status = patch.status;

    await prisma.projectReport.update({ where: { id }, data });
    return this.getById(id);
  }

  /** Clear one override path, falling back to the auto value. */
  async clearOverride(id, path) {
    const report = await prisma.projectReport.findUnique({
      where: { id },
      select: { overrides: true },
    });
    if (!report) throw ApiError.notFound("Report not found");

    const overrides = { ...(report.overrides || {}) };
    delete overrides[path];
    await prisma.projectReport.update({ where: { id }, data: { overrides } });
    return this.getById(id);
  }

  async remove(id) {
    const report = await prisma.projectReport.findUnique({ where: { id }, select: { id: true } });
    if (!report) throw ApiError.notFound("Report not found");
    await prisma.projectReport.delete({ where: { id } });
  }
}

export default new ReportService();
