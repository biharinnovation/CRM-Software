import prisma from "../../utils/prisma.js";
import { costOfTask } from "../expense/expense.service.js";

/**
 * Computes start/end date boundaries for the current and previous periods.
 *
 * Periods:
 *   "all"   → Everything till date (no comparison)
 *   "year"  → This calendar year vs previous year
 *   "today" → Today vs yesterday
 *   "month" → This calendar month vs previous month (default)
 */
function getPeriodBounds(period) {
  const now = new Date();

  switch (period) {
    case "all":
      return {
        current: {},
        previous: null, // no comparison
        label: "Till Date",
      };

    case "year": {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      const startOfLastYear = new Date(now.getFullYear() - 1, 0, 1);
      const endOfLastYear = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
      return {
        current: { gte: startOfYear },
        previous: { gte: startOfLastYear, lte: endOfLastYear },
        label: `${now.getFullYear()}`,
      };
    }

    case "today": {
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const endOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
      return {
        current: { gte: startOfToday },
        previous: { gte: startOfYesterday, lte: endOfYesterday },
        label: "Today",
      };
    }

    case "month":
    default: {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return {
        current: { gte: startOfMonth },
        previous: { gte: startOfLastMonth, lte: endOfLastMonth },
        label: new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      };
    }
  }
}

/**
 * Fetches aggregated dashboard statistics for the Owner panel.
 *
 * @param {string} period – "all" | "year" | "today" | "month"
 */
export async function getDashboardStats(period = "month") {
  const bounds = getPeriodBounds(period);
  const { current, previous } = bounds;

  // Build a date filter for Prisma where clauses
  const dateWhere = Object.keys(current).length > 0 ? { createdAt: current } : {};
  const prevDateWhere = previous ? { createdAt: previous } : null;

  // ─── Build all queries in parallel ──────────────────────────

  const queries = [
    // 0-1: Users (always all-time — they're a roster, not events)
    prisma.user.count(),
    prisma.user.count({ where: { status: "ACTIVE" } }),

    // 2-4: Leads — current period
    prisma.lead.count({ where: dateWhere }),
    prisma.lead.groupBy({
      by: ["status"],
      _count: { id: true },
      ...(Object.keys(dateWhere).length > 0 ? { where: dateWhere } : {}),
    }),

    // 5-9: Deals — current period
    prisma.deal.count({ where: dateWhere }),
    prisma.deal.groupBy({
      by: ["stage"],
      _count: { id: true },
      ...(Object.keys(dateWhere).length > 0 ? { where: dateWhere } : {}),
    }),
    prisma.deal.aggregate({
      _sum: { value: true },
      ...(Object.keys(dateWhere).length > 0 ? { where: dateWhere } : {}),
    }),
    prisma.deal.aggregate({
      _sum: { value: true },
      where: { stage: "WON", ...dateWhere },
    }),

    // 8-9: Clients — current period new + always-all active
    prisma.client.count({ where: dateWhere }),
    prisma.client.count({ where: { status: "ACTIVE" } }),

    // 10-11: Projects — current period
    prisma.project.count({ where: dateWhere }),
    prisma.project.groupBy({
      by: ["status"],
      _count: { id: true },
      ...(Object.keys(dateWhere).length > 0 ? { where: dateWhere } : {}),
    }),

    // 12-13: Recent activity (always last 5)
    prisma.lead.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      ...(Object.keys(dateWhere).length > 0 ? { where: dateWhere } : {}),
      select: {
        id: true,
        companyName: true,
        contactName: true,
        status: true,
        priority: true,
        estimatedValue: true,
        createdAt: true,
      },
    }),
    prisma.deal.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      ...(Object.keys(dateWhere).length > 0 ? { where: dateWhere } : {}),
      select: {
        id: true,
        title: true,
        stage: true,
        value: true,
        createdAt: true,
        lead: { select: { companyName: true } },
      },
    }),
  ];

  // If we have a comparison period, add previous-period queries
  if (prevDateWhere) {
    queries.push(
      // 14: Previous leads
      prisma.lead.count({ where: prevDateWhere }),
      // 15: Previous deals
      prisma.deal.count({ where: prevDateWhere }),
      // 16: Previous clients
      prisma.client.count({ where: prevDateWhere }),
      // 17: Previous projects
      prisma.project.count({ where: prevDateWhere }),
      // 18: Previous won deal value
      prisma.deal.aggregate({
        _sum: { value: true },
        where: { stage: "WON", ...prevDateWhere },
      }),
    );
  }

  const results = await Promise.all(queries);

  // Destructure results
  const [
    totalUsers,
    activeUsers,
    totalLeads,
    leadsByStatus,
    totalDeals,
    dealsByStage,
    totalDealValue,
    wonDealValue,
    totalClients,
    activeClients,
    totalProjects,
    projectsByStatus,
    recentLeads,
    recentDeals,
  ] = results;

  // Previous period values (only if comparison exists)
  const prevLeads = prevDateWhere ? results[14] : null;
  const prevDeals = prevDateWhere ? results[15] : null;
  const prevClients = prevDateWhere ? results[16] : null;
  const prevProjects = prevDateWhere ? results[17] : null;
  const prevWonValue = prevDateWhere ? results[18] : null;

  // ─── Helpers ────────────────────────────────────────────────

  const toMap = (grouped) =>
    grouped.reduce((acc, item) => {
      const key = item.status || item.stage;
      acc[key] = item._count.id;
      return acc;
    }, {});

  const calcChange = (current, previous) => {
    if (previous === null || previous === undefined) return null;
    if (previous === 0) return current > 0 ? 100 : 0;
    return parseFloat((((current - previous) / previous) * 100).toFixed(1));
  };

  // ─── Response ───────────────────────────────────────────────

  return {
    period,
    periodLabel: bounds.label,
    hasComparison: !!prevDateWhere,
    users: {
      total: totalUsers,
      active: activeUsers,
    },
    leads: {
      total: totalLeads,
      previous: prevLeads,
      change: calcChange(totalLeads, prevLeads),
      byStatus: toMap(leadsByStatus),
    },
    deals: {
      total: totalDeals,
      previous: prevDeals,
      change: calcChange(totalDeals, prevDeals),
      byStage: toMap(dealsByStage),
      totalValue: totalDealValue._sum.value || 0,
      wonValue: wonDealValue._sum.value || 0,
      prevWonValue: prevWonValue?._sum?.value || 0,
      wonValueChange: calcChange(
        Number(wonDealValue._sum.value || 0),
        prevWonValue ? Number(prevWonValue._sum.value || 0) : null
      ),
    },
    clients: {
      total: totalClients,
      active: activeClients,
      previous: prevClients,
      change: calcChange(totalClients, prevClients),
    },
    projects: {
      total: totalProjects,
      previous: prevProjects,
      change: calcChange(totalProjects, prevProjects),
      byStatus: toMap(projectsByStatus),
    },
    recentLeads,
    recentDeals,
  };
}

/**
 * Fetches dashboard statistics scoped to a specific client company.
 *
 * @param {string} clientId – The client company ID
 */
export async function getClientDashboardStats(clientId) {
  const now = new Date();

  const [
    totalProjects,
    activeProjects,
    projectIds,
    recentDocuments,
    upcomingMeetings,
  ] = await Promise.all([
    // Total projects for this client
    prisma.project.count({ where: { clientId } }),

    // Active projects (IN_PROGRESS)
    prisma.project.count({ where: { clientId, status: "IN_PROGRESS" } }),

    // All project IDs for this client (needed for task/milestone queries)
    prisma.project.findMany({
      where: { clientId },
      select: { id: true },
    }),

    // Recent documents across client's projects
    prisma.document.findMany({
      where: {
        project: { clientId },
      },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        type: true,
        fileUrl: true,
        requiresSignature: true,
        isSigned: true,
        createdAt: true,
        project: { select: { id: true, name: true } },
      },
    }),

    // Upcoming meetings linked to client's projects
    prisma.meeting.findMany({
      where: {
        project: { clientId },
        scheduledAt: { gte: now },
        status: { in: ["SCHEDULED"] },
      },
      take: 5,
      orderBy: { scheduledAt: "asc" },
      select: {
        id: true,
        title: true,
        mode: true,
        status: true,
        scheduledAt: true,
        duration: true,
        project: { select: { id: true, name: true } },
      },
    }),
  ]);

  const pIds = projectIds.map((p) => p.id);

  // Task and milestone queries scoped to client projects
  const [
    totalTasks,
    completedTasks,
    reviewTasks,
    upcomingMilestones,
    projectsList,
  ] = await Promise.all([
    prisma.task.count({ where: { projectId: { in: pIds } } }),
    prisma.task.count({ where: { projectId: { in: pIds }, status: "COMPLETED" } }),
    prisma.task.count({ where: { projectId: { in: pIds }, status: "IN_REVIEW" } }),

    // Upcoming milestones
    prisma.milestone.findMany({
      where: {
        projectId: { in: pIds },
        status: { in: ["PENDING", "IN_PROGRESS"] },
      },
      take: 5,
      orderBy: { dueDate: "asc" },
      select: {
        id: true,
        title: true,
        status: true,
        dueDate: true,
        project: { select: { id: true, name: true } },
      },
    }),

    // Projects with status for overview
    prisma.project.findMany({
      where: { clientId },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        name: true,
        status: true,
        startDate: true,
        endDate: true,
        _count: { select: { tasks: true, milestones: true } },
      },
    }),
  ]);

  return {
    projects: {
      total: totalProjects,
      active: activeProjects,
    },
    tasks: {
      total: totalTasks,
      completed: completedTasks,
      inReview: reviewTasks,
    },
    upcomingMilestones,
    recentDocuments,
    upcomingMeetings,
    projectsList,
  };
}

/**
 * Fetches dashboard statistics scoped to an employee user (via team membership).
 *
 * @param {string} userId – The employee user ID
 * @param {string[]} projectIds – Pre-resolved project IDs from getUserProjectIds()
 */
export async function getEmployeeDashboardStats(userId) {
  const now = new Date();

  // Midnight seven days back, so "last 7 days" covers whole days including today.
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);

  const weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 7);

  const OPEN_STATUSES = ["NEW", "ACKNOWLEDGED", "IN_PROGRESS", "IN_REVIEW", "CLIENT_REVIEW"];

  const TASK_FIELDS = {
    id: true,
    title: true,
    status: true,
    priority: true,
    dueDate: true,
    completedAt: true,
    updatedAt: true,
    project: { select: { id: true, name: true } },
  };

  const [
    byStatus,
    overdueCount,
    dueSoonCount,
    completedThisWeek,
    assignedThisWeek,
    recentTasks,
    dueSoonTasks,
    overdueTasks,
    delegatedByStatus,
    delegatedTasks,
    delegatedOverdue,
  ] = await Promise.all([
    prisma.task.groupBy({
      by: ["status"],
      where: { assigneeId: userId },
      _count: { id: true },
    }),

    prisma.task.count({
      where: { assigneeId: userId, status: { in: OPEN_STATUSES }, dueDate: { lt: now } },
    }),

    prisma.task.count({
      where: {
        assigneeId: userId,
        status: { in: OPEN_STATUSES },
        dueDate: { gte: now, lte: weekAhead },
      },
    }),

    // Raw rows for the 7-day chart — grouping by day is done below, since
    // Prisma cannot truncate a timestamp to a date in groupBy.
    prisma.task.findMany({
      where: { assigneeId: userId, completedAt: { gte: weekStart } },
      select: { completedAt: true },
    }),

    prisma.task.findMany({
      where: { assigneeId: userId, createdAt: { gte: weekStart } },
      select: { createdAt: true },
    }),

    prisma.task.findMany({
      where: { assigneeId: userId },
      take: 8,
      orderBy: { updatedAt: "desc" },
      select: TASK_FIELDS,
    }),

    prisma.task.findMany({
      where: {
        assigneeId: userId,
        status: { in: OPEN_STATUSES },
        dueDate: { gte: now, lte: weekAhead },
      },
      take: 5,
      orderBy: { dueDate: "asc" },
      select: TASK_FIELDS,
    }),

    prisma.task.findMany({
      where: { assigneeId: userId, status: { in: OPEN_STATUSES }, dueDate: { lt: now } },
      take: 5,
      orderBy: { dueDate: "asc" },
      select: TASK_FIELDS,
    }),

    // Work handed to someone else. Self-assigned tasks are excluded so they do
    // not show up twice, once under each heading.
    prisma.task.groupBy({
      by: ["status"],
      where: { assignedById: userId, NOT: { assigneeId: userId } },
      _count: { id: true },
    }),

    prisma.task.findMany({
      where: { assignedById: userId, NOT: { assigneeId: userId } },
      take: 6,
      orderBy: { updatedAt: "desc" },
      select: {
        ...TASK_FIELDS,
        assignee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    }),

    prisma.task.count({
      where: {
        assignedById: userId,
        NOT: { assigneeId: userId },
        status: { in: OPEN_STATUSES },
        dueDate: { lt: now },
      },
    }),
  ]);

  const statusCount = (status) => byStatus.find((r) => r.status === status)?._count.id ?? 0;
  const total = byStatus.reduce((sum, r) => sum + r._count.id, 0);

  const delegatedCount = (status) =>
    delegatedByStatus.find((r) => r.status === status)?._count.id ?? 0;

  // Build the seven day buckets, oldest first, so the chart never has gaps.
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const buckets = [];
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + i);
    buckets.push({ date: dayKey(day), completed: 0, assigned: 0 });
  }
  const bucketFor = (d) => buckets.find((b) => b.date === dayKey(d));

  for (const t of completedThisWeek) {
    const b = bucketFor(t.completedAt);
    if (b) b.completed += 1;
  }
  for (const t of assignedThisWeek) {
    const b = bucketFor(t.createdAt);
    if (b) b.assigned += 1;
  }

  return {
    tasks: {
      total,
      new: statusCount("NEW"),
      acknowledged: statusCount("ACKNOWLEDGED"),
      inProgress: statusCount("IN_PROGRESS"),
      inReview: statusCount("IN_REVIEW"),
      clientReview: statusCount("CLIENT_REVIEW"),
      completed: statusCount("COMPLETED"),
      open: OPEN_STATUSES.reduce((sum, st) => sum + statusCount(st), 0),
      overdue: overdueCount,
      dueSoon: dueSoonCount,
    },
    last7Days: buckets,
    weekTotals: {
      completed: completedThisWeek.length,
      assigned: assignedThisWeek.length,
    },
    recentTasks,
    dueSoonTasks,
    overdueTasks,
    delegated: {
      total: delegatedByStatus.reduce((sum, r) => sum + r._count.id, 0),
      new: delegatedCount("NEW"),
      acknowledged: delegatedCount("ACKNOWLEDGED"),
      inProgress: delegatedCount("IN_PROGRESS"),
      inReview: delegatedCount("IN_REVIEW"),
      clientReview: delegatedCount("CLIENT_REVIEW"),
      completed: delegatedCount("COMPLETED"),
      open: OPEN_STATUSES.reduce((sum, st) => sum + delegatedCount(st), 0),
      overdue: delegatedOverdue,
      tasks: delegatedTasks,
    },
  };
}

/**
 * Fetches dashboard statistics for a Sales Manager.
 * Shows the full sales pipeline: leads, deals, conversions, follow-ups, meetings.
 */
export async function getSalesDashboardStats() {
  const now = new Date();

  const [
    totalLeads,
    leadsByStatus,
    totalDeals,
    dealsByStage,
    totalDealValue,
    wonDealValue,
    wonDealsCount,
    recentLeads,
    recentDeals,
    upcomingFollowUps,
    upcomingMeetings,
  ] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.groupBy({
      by: ["status"],
      _count: { id: true },
    }),
    prisma.deal.count(),
    prisma.deal.groupBy({
      by: ["stage"],
      _count: { id: true },
    }),
    prisma.deal.aggregate({ _sum: { value: true } }),
    prisma.deal.aggregate({ _sum: { value: true }, where: { stage: "WON" } }),
    prisma.deal.count({ where: { stage: "WON" } }),

    // Recent leads
    prisma.lead.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        companyName: true,
        contactName: true,
        status: true,
        priority: true,
        estimatedValue: true,
        source: true,
        createdAt: true,
      },
    }),

    // Recent deals
    prisma.deal.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        stage: true,
        value: true,
        createdAt: true,
        lead: { select: { companyName: true } },
      },
    }),

    // Upcoming follow-ups
    prisma.followUp.findMany({
      where: {
        status: { in: ["PENDING", "OVERDUE"] },
        dueAt: { gte: now },
      },
      take: 5,
      orderBy: { dueAt: "asc" },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        dueAt: true,
        lead: { select: { id: true, companyName: true } },
      },
    }),

    // Upcoming meetings (linked to leads or deals)
    prisma.meeting.findMany({
      where: {
        scheduledAt: { gte: now },
        status: "SCHEDULED",
        OR: [{ leadId: { not: null } }, { dealId: { not: null } }],
      },
      take: 5,
      orderBy: { scheduledAt: "asc" },
      select: {
        id: true,
        title: true,
        mode: true,
        status: true,
        scheduledAt: true,
        duration: true,
        lead: { select: { id: true, companyName: true } },
        deal: { select: { id: true, title: true } },
      },
    }),
  ]);

  const toMap = (grouped) =>
    grouped.reduce((acc, item) => {
      const key = item.status || item.stage;
      acc[key] = item._count.id;
      return acc;
    }, {});

  const conversionRate = totalDeals > 0
    ? parseFloat(((wonDealsCount / totalDeals) * 100).toFixed(1))
    : 0;

  return {
    leads: {
      total: totalLeads,
      byStatus: toMap(leadsByStatus),
    },
    deals: {
      total: totalDeals,
      byStage: toMap(dealsByStage),
      totalValue: totalDealValue._sum.value || 0,
      wonValue: wonDealValue._sum.value || 0,
      wonCount: wonDealsCount,
      conversionRate,
    },
    recentLeads,
    recentDeals,
    upcomingFollowUps,
    upcomingMeetings,
  };
}

/**
 * Fetches dashboard statistics for an Account Manager.
 * Scoped to clients and projects they manage.
 *
 * @param {string} userId - The account manager's user ID
 */
export async function getAccountDashboardStats(userId) {
  const now = new Date();

  // Get managed project IDs
  const managedProjects = await prisma.project.findMany({
    where: { accountManagerId: userId },
    select: { id: true },
  });
  const pIds = managedProjects.map((p) => p.id);

  const [
    totalClients,
    activeClients,
    totalProjects,
    activeProjects,
    totalTasks,
    completedTasks,
    inReviewTasks,
    upcomingMilestones,
    recentDocuments,
    upcomingMeetings,
    clientsList,
    projectsList,
  ] = await Promise.all([
    prisma.client.count({ where: { accountManagerId: userId } }),
    prisma.client.count({ where: { accountManagerId: userId, status: "ACTIVE" } }),

    prisma.project.count({ where: { accountManagerId: userId } }),
    prisma.project.count({ where: { accountManagerId: userId, status: "IN_PROGRESS" } }),

    prisma.task.count({ where: { projectId: { in: pIds } } }),
    prisma.task.count({ where: { projectId: { in: pIds }, status: "COMPLETED" } }),
    prisma.task.count({ where: { projectId: { in: pIds }, status: "IN_REVIEW" } }),

    prisma.milestone.findMany({
      where: { projectId: { in: pIds }, status: { in: ["PENDING", "IN_PROGRESS"] } },
      take: 5,
      orderBy: { dueDate: "asc" },
      select: {
        id: true, title: true, status: true, dueDate: true,
        project: { select: { id: true, name: true } },
      },
    }),

    prisma.document.findMany({
      where: { projectId: { in: pIds } },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, type: true, fileUrl: true, requiresSignature: true, isSigned: true, createdAt: true,
        project: { select: { id: true, name: true } },
      },
    }),

    prisma.meeting.findMany({
      where: { projectId: { in: pIds }, scheduledAt: { gte: now }, status: "SCHEDULED" },
      take: 5,
      orderBy: { scheduledAt: "asc" },
      select: {
        id: true, title: true, mode: true, status: true, scheduledAt: true, duration: true,
        project: { select: { id: true, name: true } },
      },
    }),

    prisma.client.findMany({
      where: { accountManagerId: userId },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true, companyName: true, contactName: true, status: true,
        _count: { select: { projects: true } },
      },
    }),

    prisma.project.findMany({
      where: { accountManagerId: userId },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true, name: true, status: true, startDate: true, endDate: true,
        client: { select: { companyName: true } },
        _count: { select: { tasks: true, milestones: true } },
      },
    }),
  ]);

  return {
    clients: { total: totalClients, active: activeClients },
    projects: { total: totalProjects, active: activeProjects },
    tasks: { total: totalTasks, completed: completedTasks, inReview: inReviewTasks },
    upcomingMilestones,
    recentDocuments,
    upcomingMeetings,
    clientsList,
    projectsList,
  };
}

/**
 * HR / OWNER / ADMIN attendance-focused dashboard.
 * Shows today's attendance snapshot, pending leaves, upcoming holidays.
 */
export async function getHrDashboardStats() {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const in30Days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 30));

  const [
    totalActiveUsers,
    todayAttendance,
    pendingLeaveCount,
    recentLeaveRequests,
    upcomingHolidays,
  ] = await Promise.all([
    prisma.user.count({ where: { status: "ACTIVE", role: { not: "CLIENT" } } }),
    prisma.attendance.findMany({
      where: { date: todayUtc },
      select: { id: true, status: true, userId: true },
    }),
    prisma.leaveRequest.count({ where: { status: "PENDING" } }),
    prisma.leaveRequest.findMany({
      where: { status: "PENDING" },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatar: true, role: true } },
        leaveType: { select: { id: true, name: true, color: true } },
      },
    }),
    prisma.holiday.findMany({
      where: { date: { gte: todayUtc, lte: in30Days } },
      take: 5,
      orderBy: { date: "asc" },
    }),
  ]);

  // Group today's attendance by status
  const byStatus = todayAttendance.reduce((acc, a) => {
    acc[a.status] = (acc[a.status] || 0) + 1;
    return acc;
  }, {});

  const presentCount = (byStatus.PRESENT || 0) + (byStatus.WORK_FROM_HOME || 0) + (byStatus.ON_DUTY || 0);
  const halfDayCount = (byStatus.HALF_DAY_FIRST || 0) + (byStatus.HALF_DAY_SECOND || 0);
  const onLeaveCount = byStatus.ON_LEAVE || 0;
  const absentCount = byStatus.ABSENT || 0;
  const notMarkedCount = Math.max(totalActiveUsers - todayAttendance.length, 0);

  return {
    totalActiveUsers,
    today: {
      present: presentCount,
      halfDay: halfDayCount,
      onLeave: onLeaveCount,
      absent: absentCount,
      notMarked: notMarkedCount,
      byStatus,
    },
    pendingLeaveCount,
    recentLeaveRequests,
    upcomingHolidays,
  };
}

/**
 * Finance dashboard — everything derived from invoices.
 *
 * Money is stored as Decimal, so every aggregate is converted with Number()
 * before it leaves this function; Decimal instances do not survive JSON.
 */
/**
 * Company-wide profit and loss.
 *
 * Income has two readings and they answer different questions:
 *   - contracted: what projects are worth (project budgets)
 *   - billed / collected: what has actually been invoiced and received
 *
 * Cost is the sum of three streams that until now lived apart: staff expense
 * claims, team time on tasks, and money spent on ads.
 */
/**
 * Turn a range request into concrete bounds.
 *
 * @param {object} range { preset: "all"|"month"|"year"|"custom", from?, to? }
 * @returns {{from: Date|null, to: Date|null, label: string}} null bounds mean all time
 */
export function resolveRange(range = {}) {
  const now = new Date();
  const preset = range.preset || "all";

  if (preset === "month") {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1),
      to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      label: "This month",
    };
  }
  if (preset === "year") {
    return {
      from: new Date(now.getFullYear(), 0, 1),
      to: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
      label: "This year",
    };
  }
  if (preset === "custom" && (range.from || range.to)) {
    const from = range.from ? new Date(range.from) : null;
    const to = range.to ? new Date(range.to) : null;
    if (to) to.setHours(23, 59, 59, 999);
    return { from, to, label: "Custom range" };
  }
  return { from: null, to: null, label: "All time" };
}

/** Prisma date filter, or undefined when the range is unbounded. */
function dateFilter({ from, to }) {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
}

async function getProfitAndLoss(range = { from: null, to: null }) {
  const num = (v) => Number(v || 0);

  const window = dateFilter(range);

  const [projects, expenseRows, tasks, adSpend, invoiceAgg, collectedAgg] = await Promise.all([
    // Contracted value is dated by when the project started.
    prisma.project.aggregate({
      where: {
        status: { notIn: ["CANCELLED"] },
        ...(window ? { startDate: window } : {}),
      },
      _sum: { budget: true },
      _count: { id: true },
    }),

    // Approved and settled claims only — pending money is not yet spent.
    prisma.expense.groupBy({
      by: ["status"],
      where: {
        status: { in: ["APPROVED", "PAID", "PENDING"] },
        ...(window ? { expenseDate: window } : {}),
      },
      _sum: { totalAmount: true },
    }),

    // Every task carrying a rate, with the feedback trail costOfTask needs.
    // Team time counts in the period the work finished. A running task has no
    // completion date, so it only appears in the all-time view.
    prisma.task.findMany({
      where: {
        internalCostType: { not: "NONE" },
        ...(window ? { completedAt: window } : {}),
      },
      select: {
        completedAt: true,
        internalCostAmount: true,
        internalCostType: true,
        feedbacks: { select: { statusAfter: true, createdAt: true } },
      },
    }),

    prisma.campaignDailyStat.aggregate({
      where: window ? { date: window } : {},
      _sum: { spend: true },
    }),

    // Billed is dated by issue; collected is dated by payment, so they need
    // separate queries once a range is applied.
    prisma.invoice.aggregate({
      where: {
        status: { notIn: ["DRAFT", "CANCELLED"] },
        isActive: true,
        ...(window ? { issueDate: window } : {}),
      },
      _sum: { total: true, amountPaid: true },
    }),

    prisma.invoicePayment.aggregate({
      where: { invoice: { isActive: true }, ...(window ? { paidAt: window } : {}) },
      _sum: { amount: true },
    }),
  ]);

  const expenseOf = (st) => num(expenseRows.find((r) => r.status === st)?._sum.totalAmount);
  const expensesSettled = expenseOf("APPROVED") + expenseOf("PAID");
  const expensesPending = expenseOf("PENDING");

  const taskCost = tasks.reduce((sum, t) => sum + costOfTask(t).cost, 0);
  const adSpendTotal = num(adSpend._sum.spend);

  const totalCost = expensesSettled + taskCost + adSpendTotal;

  const contracted = num(projects._sum.budget);
  const billed = num(invoiceAgg._sum.total);
  // Within a range, "collected" means money that arrived in that window —
  // which is a different set of invoices from the ones issued in it.
  const collected = window
    ? num(collectedAgg._sum.amount)
    : num(invoiceAgg._sum.amountPaid);

  const pct = (value, base) => (base > 0 ? Math.round((value / base) * 100) : null);

  return {
    income: {
      contracted,
      projectCount: projects._count.id,
      billed,
      collected,
      // Invoiced but not yet paid — owed to us.
      receivable: billed - collected,
      // Contracted but not yet invoiced — still to bill.
      unbilled: Math.max(0, contracted - billed),
    },
    cost: {
      expenses: expensesSettled,
      expensesPending,
      taskCost,
      adSpend: adSpendTotal,
      total: totalCost,
    },
    profit: {
      // What is actually in the bank against what has been spent.
      realised: collected - totalCost,
      realisedMargin: pct(collected - totalCost, collected),
      // Everything invoiced, settled or not.
      billedProfit: billed - totalCost,
      billedMargin: pct(billed - totalCost, billed),
      // The full book of work, if every project bills in full.
      projected: contracted - totalCost,
      projectedMargin: pct(contracted - totalCost, contracted),
    },
  };
}

export async function getFinanceDashboardStats(rangeInput = {}) {
  const now = new Date();
  const range = resolveRange(rangeInput);
  const window = dateFilter(range);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  // 6 months back, inclusive of the current one.
  const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const OPEN_STATUSES = ["SENT", "PARTIALLY_PAID", "OVERDUE"];
  const num = (v) => Number(v || 0);

  const [
    byStatus,
    openInvoices,
    paidThisMonth,
    paidThisYear,
    trendRows,
    recentInvoices,
    overdueInvoices,
    projectCount,
    clientCount,
  ] = await Promise.all([
    prisma.invoice.groupBy({
      by: ["status"],
      where: { isActive: true, ...(window ? { issueDate: window } : {}) },
      _count: { id: true },
      _sum: { total: true, amountPaid: true },
    }),

    // Anything still owed, for the outstanding figure and the top-debtor list.
    prisma.invoice.findMany({
      where: { status: { in: OPEN_STATUSES }, isActive: true },
      select: {
        id: true, invoiceNumber: true, total: true, amountPaid: true, dueDate: true, status: true,
        client: { select: { id: true, companyName: true } },
        project: { select: { id: true, name: true } },
      },
    }),

    prisma.invoice.aggregate({
      where: { status: "PAID", paidAt: { gte: monthStart }, isActive: true },
      _sum: { total: true },
      _count: { id: true },
    }),

    prisma.invoice.aggregate({
      where: { status: "PAID", paidAt: { gte: yearStart }, isActive: true },
      _sum: { total: true },
    }),

    // Raw rows for the 6-month trend; grouping by month happens below.
    prisma.invoice.findMany({
      where: { issueDate: { gte: trendStart }, isActive: true },
      select: { issueDate: true, total: true, amountPaid: true, status: true },
    }),

    prisma.invoice.findMany({
      where: { isActive: true, ...(window ? { issueDate: window } : {}) },
      take: 8,
      orderBy: { issueDate: "desc" },
      select: {
        id: true, invoiceNumber: true, status: true, total: true, amountPaid: true,
        issueDate: true, dueDate: true,
        client: { select: { id: true, companyName: true } },
        project: { select: { id: true, name: true } },
      },
    }),

    prisma.invoice.findMany({
      where: {
        status: { in: OPEN_STATUSES },
        dueDate: { lt: now },
        isActive: true,
      },
      take: 6,
      orderBy: { dueDate: "asc" },
      select: {
        id: true, invoiceNumber: true, status: true, total: true, amountPaid: true, dueDate: true,
        client: { select: { id: true, companyName: true } },
        project: { select: { id: true, name: true } },
      },
    }),

    prisma.project.count(),
    prisma.client.count(),
  ]);

  const pnl = await getProfitAndLoss(range);

  const statusRow = (s) => byStatus.find((r) => r.status === s);
  const countOf = (s) => statusRow(s)?._count.id ?? 0;

  const billedTotal = byStatus
    .filter((r) => r.status !== "DRAFT" && r.status !== "CANCELLED")
    .reduce((sum, r) => sum + num(r._sum.total), 0);

  const collectedTotal = byStatus
    .filter((r) => r.status !== "CANCELLED")
    .reduce((sum, r) => sum + num(r._sum.amountPaid), 0);

  const outstanding = openInvoices.reduce(
    (sum, inv) => sum + (num(inv.total) - num(inv.amountPaid)),
    0
  );

  const overdueValue = openInvoices
    .filter((inv) => inv.dueDate && new Date(inv.dueDate) < now)
    .reduce((sum, inv) => sum + (num(inv.total) - num(inv.amountPaid)), 0);

  // Owed per client, biggest first — who to chase.
  const debtorMap = new Map();
  for (const inv of openInvoices) {
    const key = inv.client?.id || "unassigned";
    const name = inv.client?.companyName || "Unassigned";
    const due = num(inv.total) - num(inv.amountPaid);
    if (due <= 0) continue;
    const prev = debtorMap.get(key) || { id: key, name, amount: 0, invoices: 0 };
    prev.amount += due;
    prev.invoices += 1;
    debtorMap.set(key, prev);
  }
  const topDebtors = [...debtorMap.values()].sort((a, b) => b.amount - a.amount).slice(0, 5);

  // Six month buckets, oldest first, pre-seeded so quiet months are not gaps.
  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const months = [];
  for (let i = 0; i < 6; i += 1) {
    const d = new Date(trendStart.getFullYear(), trendStart.getMonth() + i, 1);
    months.push({
      month: monthKey(d),
      label: d.toLocaleDateString("en-IN", { month: "short" }),
      billed: 0,
      collected: 0,
    });
  }
  for (const inv of trendRows) {
    if (inv.status === "CANCELLED") continue;
    const bucket = months.find((m) => m.month === monthKey(new Date(inv.issueDate)));
    if (!bucket) continue;
    if (inv.status !== "DRAFT") bucket.billed += num(inv.total);
    bucket.collected += num(inv.amountPaid);
  }

  const shape = (inv) => ({
    ...inv,
    total: num(inv.total),
    amountPaid: num(inv.amountPaid),
    due: num(inv.total) - num(inv.amountPaid),
  });

  return {
    totals: {
      billed: billedTotal,
      collected: collectedTotal,
      outstanding,
      overdueValue,
      collectionRate: billedTotal > 0 ? Math.round((collectedTotal / billedTotal) * 100) : 0,
      thisMonthCollected: num(paidThisMonth._sum.total),
      thisMonthPaidCount: paidThisMonth._count.id,
      thisYearCollected: num(paidThisYear._sum.total),
    },
    counts: {
      total: byStatus.reduce((sum, r) => sum + r._count.id, 0),
      draft: countOf("DRAFT"),
      sent: countOf("SENT"),
      partiallyPaid: countOf("PARTIALLY_PAID"),
      paid: countOf("PAID"),
      overdue: openInvoices.filter((i) => i.dueDate && new Date(i.dueDate) < now).length,
      cancelled: countOf("CANCELLED"),
      projects: projectCount,
      clients: clientCount,
    },
    pnl,
    range: { preset: rangeInput.preset || "all", label: range.label, from: range.from, to: range.to },
    trend: months,
    topDebtors,
    recentInvoices: recentInvoices.map(shape),
    overdueInvoices: overdueInvoices.map(shape),
  };
}
