import prisma from "../../utils/prisma.js";
import { ApiError } from "../../utils/apiError.js";
import { costOfTask } from "../expense/expense.service.js";
import packageService from "../package/package.service.js";

/**
 * Compute the next billing date from a reference date + billing cycle.
 * Returns null for ONE_TIME.
 */
function computeNextBillingDate(referenceDate, billingCycle) {
  if (!referenceDate || billingCycle === "ONE_TIME") return null;
  const d = new Date(referenceDate);
  switch (billingCycle) {
    case "MONTHLY":
      d.setMonth(d.getMonth() + 1);
      break;
    case "QUARTERLY":
      d.setMonth(d.getMonth() + 3);
      break;
    case "SEMI_ANNUAL":
      d.setMonth(d.getMonth() + 6);
      break;
    case "ANNUAL":
      d.setFullYear(d.getFullYear() + 1);
      break;
    default:
      return null;
  }
  return d;
}

const PROJECT_INCLUDE = {
  client: {
    select: { id: true, companyName: true, contactName: true, email: true, status: true },
  },
  deal: {
    select: { id: true, title: true, value: true },
  },
  accountManager: {
    select: { id: true, firstName: true, lastName: true, email: true, role: true },
  },
  createdBy: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
  projectServices: {
    include: {
      service: {
        select: { id: true, name: true, price: true, salePrice: true, points: true, isActive: true },
      },
      package: { select: { id: true, name: true } },
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  },
  projectTeams: {
    include: {
      team: {
        select: {
          id: true,
          name: true,
          description: true,
          _count: { select: { members: true } },
          lead: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  },
};

class ProjectService {
  /**
   * Create project manually under a client
   */
  async createProject(data, createdById) {
    const client = await prisma.client.findUnique({ where: { id: data.clientId } });
    if (!client) throw ApiError.notFound("Client not found");

    if (client.status !== "ACTIVE") {
      throw ApiError.badRequest("Cannot create project for an inactive client");
    }

    if (data.accountManagerId) {
      const am = await prisma.user.findUnique({ where: { id: data.accountManagerId } });
      if (!am) throw ApiError.badRequest("Account manager not found");
      if (am.role === "CLIENT") {
        throw ApiError.badRequest("Account manager cannot be a client");
      }
    }

    if (data.startDate && data.endDate && new Date(data.startDate) > new Date(data.endDate)) {
      throw ApiError.badRequest("Start date cannot be after end date");
    }

    // Auto-compute nextBillingDate for recurring projects if not explicitly set
    if (data.billingCycle && data.billingCycle !== "ONE_TIME" && !data.nextBillingDate && data.startDate) {
      data.nextBillingDate = computeNextBillingDate(data.startDate, data.billingCycle);
    }

    // Extract services and teams before creating project (not Prisma fields)
    const servicesInput = data.services;
    delete data.services;
    const teamIds = data.teamIds;
    delete data.teamIds;

    // Use transaction if we have services or teams to link
    const hasExtras = (servicesInput && servicesInput.length > 0) || (teamIds && teamIds.length > 0);

    if (hasExtras) {
      return prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: { ...data, createdById },
        });

        // Validate & create project services
        if (servicesInput && servicesInput.length > 0) {
          for (const item of servicesInput) {
            const service = await tx.service.findUnique({ where: { id: item.serviceId } });
            if (!service) throw ApiError.badRequest(`Service ${item.serviceId} not found`);

            const originalPrice = item.originalPrice ?? (service.salePrice ?? service.price);
            const price = item.price ?? originalPrice;

            await tx.projectService.create({
              data: {
                projectId: project.id,
                serviceId: item.serviceId,
                quantity: item.quantity || 1,
                price,
                originalPrice,
              },
            });
          }
        }

        // Assign teams to project
        if (teamIds && teamIds.length > 0) {
          for (const teamId of teamIds) {
            const team = await tx.team.findUnique({ where: { id: teamId } });
            if (!team) throw ApiError.badRequest(`Team ${teamId} not found`);
            await tx.projectTeam.create({
              data: { projectId: project.id, teamId },
            });
          }
        }

        // Return with full includes
        return tx.project.findUnique({
          where: { id: project.id },
          include: PROJECT_INCLUDE,
        });
      });
    }

    return prisma.project.create({
      data: { ...data, createdById },
      include: PROJECT_INCLUDE,
    });
  }

  /**
   * List projects with pagination, filters, search
   */
  async listProjects({ page, limit, status, billingCycle, clientId, accountManagerId, projectIds, search, sortBy, sortOrder }) {
    const skip = (page - 1) * limit;
    const where = {};

    if (status) where.status = status;
    if (billingCycle) where.billingCycle = billingCycle;
    if (clientId) where.clientId = clientId;
    if (accountManagerId) where.accountManagerId = accountManagerId;
    if (projectIds?.length) where.id = { in: projectIds };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { client: { companyName: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        include: PROJECT_INCLUDE,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.project.count({ where }),
    ]);

    return {
      projects,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get single project
   */
  async getProjectById(id, user = null) {
    const project = await prisma.project.findUnique({
      where: { id },
      include: PROJECT_INCLUDE,
    });

    if (!project) throw ApiError.notFound("Project not found");

    // CLIENT users only see the price they were quoted — never internal
    // catalog pricing, sale prices, or the original (pre-discount) price.
    if (user?.role === "CLIENT") {
      return {
        ...project,
        projectServices: (project.projectServices || []).map((ps) => ({
          id: ps.id,
          quantity: ps.quantity,
          price: ps.price,
          service: ps.service
            ? { id: ps.service.id, name: ps.service.name, points: ps.service.points }
            : null,
        })),
      };
    }

    return project;
  }

  /**
   * Full financial history of one project, oldest first.
   *
   * Five streams that until now lived in separate screens: invoices issued,
   * payments received, expense claims, team time on tasks, and ad spend. Each
   * entry carries a signed amount so a running balance is just a sum.
   */
  async getLedger(projectId) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true, name: true, status: true, budget: true,
        startDate: true, endDate: true, billingCycle: true,
        client: { select: { id: true, companyName: true } },
      },
    });
    if (!project) throw ApiError.notFound("Project not found");

    const [invoices, expenses, tasks, adStats] = await Promise.all([
      prisma.invoice.findMany({
        where: { projectId, status: { not: "CANCELLED" }, isActive: true },
        select: {
          id: true, invoiceNumber: true, status: true, total: true, amountPaid: true,
          issueDate: true, dueDate: true,
          payments: {
            select: {
              id: true, amount: true, method: true, paidAt: true, referenceNo: true, note: true,
              recordedBy: { select: { firstName: true, lastName: true } },
            },
          },
        },
        orderBy: { issueDate: "asc" },
      }),

      prisma.expense.findMany({
        where: { projectId, status: { in: ["APPROVED", "PAID", "PENDING"] } },
        select: {
          id: true, reference: true, title: true, totalAmount: true, status: true,
          expenseDate: true, isBillable: true, invoiceId: true,
          category: { select: { name: true, icon: true } },
          submittedBy: { select: { firstName: true, lastName: true } },
        },
        orderBy: { expenseDate: "asc" },
      }),

      prisma.task.findMany({
        where: { projectId, internalCostType: { not: "NONE" } },
        select: {
          id: true, title: true, status: true, completedAt: true, createdAt: true,
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

      prisma.campaignDailyStat.findMany({
        where: { campaign: { projectId }, spend: { gt: 0 } },
        select: {
          id: true, date: true, spend: true,
          campaign: { select: { id: true, name: true, reference: true } },
        },
        orderBy: { date: "asc" },
      }),
    ]);

    const num = (v) => Number(v || 0);

    const invoiceEntries = invoices.flatMap((inv) => [
      // Issuing an invoice books income; it does not move cash.
      {
        id: `inv-${inv.id}`,
        kind: "INVOICE",
        date: inv.issueDate,
        title: `Invoice ${inv.invoiceNumber}`,
        detail: inv.dueDate ? `Due ${inv.dueDate.toISOString().slice(0, 10)}` : null,
        status: inv.status,
        amount: num(inv.total),
        direction: "IN",
        refId: inv.id,
      },
      ...inv.payments.map((pmt) => ({
        id: `pay-${pmt.id}`,
        kind: "PAYMENT",
        date: pmt.paidAt,
        title: `Payment received · ${inv.invoiceNumber}`,
        detail: [pmt.method?.replace(/_/g, " "), pmt.referenceNo].filter(Boolean).join(" · ") || null,
        status: pmt.method,
        amount: num(pmt.amount),
        direction: "IN",
        refId: inv.id,
        by: pmt.recordedBy ? `${pmt.recordedBy.firstName} ${pmt.recordedBy.lastName}` : null,
      })),
    ]);

    const expenseEntries = expenses.map((e) => ({
      id: `exp-${e.id}`,
      kind: "EXPENSE",
      date: e.expenseDate,
      title: e.title,
      detail: [e.category?.name, e.reference, e.isBillable ? (e.invoiceId ? "billable · invoiced" : "billable") : null]
        .filter(Boolean).join(" · "),
      status: e.status,
      amount: num(e.totalAmount),
      direction: "OUT",
      refId: e.id,
      by: e.submittedBy ? `${e.submittedBy.firstName} ${e.submittedBy.lastName}` : null,
    }));

    const taskEntries = tasks
      .map((t) => ({ task: t, ...costOfTask(t) }))
      .filter((x) => x.cost > 0)
      .map(({ task: t, cost, hours, at }) => ({
        id: `task-${t.id}`,
        kind: "TASK_COST",
        // Costed on completion; a running task sits on the day it started.
        date: at || t.createdAt,
        title: t.title,
        detail: `${Math.round(hours * 10) / 10}h${t.completedAt ? "" : " · still running"}`,
        status: t.status,
        amount: cost,
        direction: "OUT",
        refId: t.id,
        by: t.assignee ? `${t.assignee.firstName} ${t.assignee.lastName}` : null,
      }));

    const adEntries = adStats.map((st) => ({
      id: `ad-${st.id}`,
      kind: "AD_SPEND",
      date: st.date,
      title: st.campaign?.name || "Ad spend",
      detail: st.campaign?.reference || null,
      status: null,
      amount: num(st.spend),
      direction: "OUT",
      refId: st.campaign?.id || null,
    }));

    const entries = [...invoiceEntries, ...expenseEntries, ...taskEntries, ...adEntries];

    entries.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Running balance of realised cash: payments in, costs out. Invoices are
    // excluded — booking one moves no money.
    let balance = 0;
    for (const e of entries) {
      if (e.kind !== "INVOICE") balance += e.direction === "IN" ? e.amount : -e.amount;
      e.balance = balance;
    }

    const sumOf = (kind) => entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amount, 0);
    const pendingExpense = expenses
      .filter((e) => e.status === "PENDING")
      .reduce((s, e) => s + num(e.totalAmount), 0);

    const billed = sumOf("INVOICE");
    const collected = sumOf("PAYMENT");
    const expenseCost = sumOf("EXPENSE") - pendingExpense;
    const taskCost = sumOf("TASK_COST");
    const adSpend = sumOf("AD_SPEND");
    const totalCost = expenseCost + taskCost + adSpend;
    const contracted = num(project.budget);
    const pct = (v, base) => (base > 0 ? Math.round((v / base) * 100) : null);

    return {
      project: { ...project, budget: contracted },
      entries,
      summary: {
        contracted,
        billed,
        collected,
        receivable: billed - collected,
        unbilled: Math.max(0, contracted - billed),
        cost: { expenses: expenseCost, pendingExpenses: pendingExpense, taskCost, adSpend, total: totalCost },
        profit: {
          realised: collected - totalCost,
          realisedMargin: pct(collected - totalCost, collected),
          billedProfit: billed - totalCost,
          billedMargin: pct(billed - totalCost, billed),
          projected: contracted - totalCost,
          projectedMargin: pct(contracted - totalCost, contracted),
        },
      },
    };
  }

  /**
   * Minimal id+name list for attribution pickers (expenses, etc).
   *
   * @param {string[]|null} projectIds  null = no restriction
   */
  async listProjectOptions(projectIds = null) {
    return prisma.project.findMany({
      where: projectIds ? { id: { in: projectIds } } : {},
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Update project
   */
  async updateProject(id, data) {
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) throw ApiError.notFound("Project not found");

    if (["COMPLETED", "CANCELLED"].includes(project.status) && data.status === undefined) {
      throw ApiError.badRequest("Cannot edit a completed or cancelled project without changing status");
    }

    if (data.accountManagerId) {
      const am = await prisma.user.findUnique({ where: { id: data.accountManagerId } });
      if (!am) throw ApiError.badRequest("Account manager not found");
      if (am.role === "CLIENT") {
        throw ApiError.badRequest("Account manager cannot be a client");
      }
    }

    const startDate = data.startDate ? new Date(data.startDate) : project.startDate;
    const endDate = data.endDate ? new Date(data.endDate) : project.endDate;
    if (startDate && endDate && startDate > endDate) {
      throw ApiError.badRequest("Start date cannot be after end date");
    }

    // Auto-recompute nextBillingDate when billingCycle changes
    const newCycle = data.billingCycle || project.billingCycle;
    if (data.billingCycle !== undefined || data.startDate !== undefined) {
      const refDate = data.startDate ? new Date(data.startDate) : project.startDate;
      if (newCycle === "ONE_TIME") {
        data.nextBillingDate = null;
      } else if (refDate && !data.nextBillingDate) {
        data.nextBillingDate = computeNextBillingDate(refDate, newCycle);
      }
    }

    // Handle teamIds separately
    const teamIds = data.teamIds;
    delete data.teamIds;

    if (teamIds !== undefined) {
      return prisma.$transaction(async (tx) => {
        const updated = await tx.project.update({
          where: { id },
          data,
        });

        // Remove existing team links and recreate
        await tx.projectTeam.deleteMany({ where: { projectId: id } });
        if (teamIds && teamIds.length > 0) {
          for (const teamId of teamIds) {
            await tx.projectTeam.create({
              data: { projectId: id, teamId },
            });
          }
        }

        return tx.project.findUnique({
          where: { id },
          include: PROJECT_INCLUDE,
        });
      });
    }

    return prisma.project.update({
      where: { id },
      data,
      include: PROJECT_INCLUDE,
    });
  }

  /**
   * Delete project (only NOT_STARTED or CANCELLED)
   */
  async deleteProject(id) {
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) throw ApiError.notFound("Project not found");

    if (!["NOT_STARTED", "CANCELLED"].includes(project.status)) {
      throw ApiError.badRequest("Only projects with status NOT_STARTED or CANCELLED can be deleted");
    }

    await prisma.project.delete({ where: { id } });
  }

  // ─── Project Services ────────────────────────────────────

  /**
   * Add (or update, if already linked) services on a project.
   * @param {string} projectId
   * @param {Array<{serviceId:string, quantity?:number, price?:number}>} services
   */
  async addServicesToProject(projectId, services) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw ApiError.notFound("Project not found");

    // New rows land at the end of the manual order; an upsert that only
    // updates an existing row must never touch its position.
    let nextPosition = await this.#nextProjectServicePosition(projectId);

    const results = [];
    for (const item of services) {
      const service = await prisma.service.findUnique({ where: { id: item.serviceId } });
      if (!service) throw ApiError.badRequest(`Service ${item.serviceId} not found`);

      // Original price = service's current effective price (salePrice or price)
      const originalPrice = service.salePrice ?? service.price;
      // Snapshot price = user-provided custom price, or the original price
      const price = item.price ?? originalPrice;

      const projectService = await prisma.projectService.upsert({
        where: { projectId_serviceId: { projectId, serviceId: item.serviceId } },
        create: {
          projectId,
          serviceId: item.serviceId,
          quantity: item.quantity || 1,
          price,
          originalPrice,
          position: nextPosition++,
        },
        update: {
          quantity: item.quantity || 1,
          price,
        },
        include: {
          service: {
            select: { id: true, name: true, price: true, salePrice: true, points: true, isActive: true },
          },
        },
      });
      results.push(projectService);
    }

    return results;
  }

  /** One past the highest position currently in use, for appending new rows. */
  async #nextProjectServicePosition(projectId) {
    const agg = await prisma.projectService.aggregate({
      where: { projectId },
      _max: { position: true },
    });
    return (agg._max.position ?? -1) + 1;
  }

  /**
   * Persist the drag-reordered service list. Takes the full ordered set of
   * ProjectService ids — position becomes the row's index in that array.
   */
  async reorderProjectServices(projectId, orderedIds) {
    const existing = await prisma.projectService.findMany({
      where: { projectId },
      select: { id: true },
    });
    const validIds = new Set(existing.map((r) => r.id));
    if (orderedIds.length !== existing.length || orderedIds.some((id) => !validIds.has(id))) {
      throw ApiError.badRequest("The service order does not match this project's current services");
    }

    await prisma.$transaction(
      orderedIds.map((id, position) =>
        prisma.projectService.update({ where: { id }, data: { position } })
      )
    );
  }

  /**
   * Update quantity / price of one linked service.
   */
  async updateProjectService(projectId, serviceId, { quantity, price }) {
    const existing = await prisma.projectService.findUnique({
      where: { projectId_serviceId: { projectId, serviceId } },
    });
    if (!existing) throw ApiError.notFound("Service not linked to this project");

    const data = {};
    if (quantity !== undefined) data.quantity = quantity;
    if (price !== undefined) data.price = price;

    return prisma.projectService.update({
      where: { projectId_serviceId: { projectId, serviceId } },
      data,
      include: {
        service: {
          select: { id: true, name: true, price: true, salePrice: true, points: true, isActive: true },
        },
      },
    });
  }

  /**
   * Remove a service from a project.
   */
  async removeServiceFromProject(projectId, serviceId) {
    const existing = await prisma.projectService.findUnique({
      where: { projectId_serviceId: { projectId, serviceId } },
    });
    if (!existing) throw ApiError.notFound("Service not linked to this project");

    await prisma.projectService.delete({
      where: { projectId_serviceId: { projectId, serviceId } },
    });
  }

  /**
   * Add every service in a package to a project in one action — see
   * DealService.addPackageToDeal for the reasoning; this mirrors it.
   */
  async addPackageToProject(projectId, packageId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw ApiError.notFound("Project not found");

    const { package: pkg, services } = await packageService.expandPackage(packageId);
    let nextPosition = await this.#nextProjectServicePosition(projectId);

    const results = await prisma.$transaction(
      services.map((item) =>
        prisma.projectService.upsert({
          where: { projectId_serviceId: { projectId, serviceId: item.serviceId } },
          create: {
            projectId,
            serviceId: item.serviceId,
            quantity: item.quantity,
            price: item.price,
            originalPrice: item.price,
            packageId,
            position: nextPosition++,
          },
          update: {
            quantity: item.quantity,
            price: item.price,
            packageId,
          },
          include: {
            service: { select: { id: true, name: true, price: true, salePrice: true, points: true, isActive: true } },
            package: { select: { id: true, name: true } },
          },
        })
      )
    );

    return { package: pkg, projectServices: results };
  }

  /** Remove every service that came from one package, as a group. */
  async removePackageFromProject(projectId, packageId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw ApiError.notFound("Project not found");

    await prisma.projectService.deleteMany({ where: { projectId, packageId } });
  }
}

export default new ProjectService();
