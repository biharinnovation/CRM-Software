import { z } from "zod";

const statuses = ["DRAFT", "SENT", "PAID", "PARTIALLY_PAID", "OVERDUE", "CANCELLED"];
const currencies = ["INR", "USD", "EUR"];

const itemSchema = z.object({
  name: z.string().min(1, "Item name is required").max(200),
  description: z.string().max(1000).optional().nullable(),
  quantity: z.coerce.number().min(0).default(1),
  unitPrice: z.coerce.number().min(0),
});

export const createInvoiceSchema = z.object({
  body: z.object({
    projectId: z.string().min(1, "Project ID is required"),
    status: z.enum(statuses).optional(),
    currency: z.enum(currencies).optional(),
    billToName: z.string().max(200).optional().nullable(),
    billToEmail: z.string().email("Invalid email").optional().nullable().or(z.literal("")),
    billToAddress: z.string().max(2000).optional().nullable(),
    items: z.array(itemSchema).min(1, "At least one line item is required"),
    discountAmount: z.coerce.number().min(0).optional(),
    cgstPercent: z.coerce.number().min(0).max(100).optional(),
    sgstPercent: z.coerce.number().min(0).max(100).optional(),
    igstPercent: z.coerce.number().min(0).max(100).optional(),
    // Omit entirely to auto-suggest from the project's last invoice; send 0
    // explicitly to waive it on purpose.
    previousDueAmount: z.coerce.number().min(0).optional(),
    issueDate: z.string().optional().nullable(),
    dueDate: z.string().optional().nullable(),
    notes: z.string().max(5000).optional().nullable(),
    paymentAccountId: z.string().optional().nullable(),
    terms: z.string().max(5000).optional().nullable(),
  }),
});

export const updateInvoiceSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    status: z.enum(statuses).optional(),
    currency: z.enum(currencies).optional(),
    billToName: z.string().max(200).optional().nullable(),
    billToEmail: z.string().email("Invalid email").optional().nullable().or(z.literal("")),
    billToAddress: z.string().max(2000).optional().nullable(),
    items: z.array(itemSchema).min(1).optional(),
    discountAmount: z.coerce.number().min(0).optional(),
    cgstPercent: z.coerce.number().min(0).max(100).optional(),
    sgstPercent: z.coerce.number().min(0).max(100).optional(),
    igstPercent: z.coerce.number().min(0).max(100).optional(),
    previousDueAmount: z.coerce.number().min(0).optional(),
    amountPaid: z.coerce.number().min(0).optional(),
    issueDate: z.string().optional().nullable(),
    dueDate: z.string().optional().nullable(),
    notes: z.string().max(5000).optional().nullable(),
    paymentAccountId: z.string().optional().nullable(),
    terms: z.string().max(5000).optional().nullable(),
  }),
});

// Empty query strings ("") should be treated as "not provided".
const emptyToUndefined = (v) => (v === "" ? undefined : v);

export const listInvoicesSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(10),
    status: z.preprocess(emptyToUndefined, z.enum(statuses).optional()),
    projectId: z.preprocess(emptyToUndefined, z.string().optional()),
    clientId: z.preprocess(emptyToUndefined, z.string().optional()),
    search: z.preprocess(emptyToUndefined, z.string().optional()),
    // OWNER/ADMIN only — ignored for everyone else, who only ever see active.
    active: z.preprocess(emptyToUndefined, z.enum(["all", "active", "inactive"]).optional()),
  }),
});

export const deactivateInvoiceSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    reason: z.string().max(1000).optional().nullable(),
  }).optional(),
});

export const getInvoiceSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

// ─── Payments ─────────────────────────────────────────

const paymentMethods = ["UPI", "BANK_TRANSFER", "CASH", "CHEQUE", "CARD", "OTHER"];

export const addPaymentSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    amount: z.coerce.number().positive("Payment amount must be more than zero"),
    method: z.enum(paymentMethods),
    paidAt: z.string().optional().nullable(),
    /// UTR, transaction id or cheque number, depending on the method.
    referenceNo: z.string().max(120).optional().nullable(),
    /// Method extras: cheque bank/date, UPI id, card last four.
    details: z.record(z.string(), z.any()).optional().nullable(),
    note: z.string().max(2000).optional().nullable(),
  }),
});

export const paymentIdParamSchema = z.object({
  params: z.object({ id: z.string().min(1), paymentId: z.string().min(1) }),
});

/** Emailing an invoice to the client. Recipients default to the bill-to address. */
export const sendInvoiceSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    to: z.string().email("Enter a valid email").optional(),
    cc: z.string().email("Enter a valid CC email").optional().or(z.literal("")),
    bcc: z.string().email("Enter a valid BCC email").optional().or(z.literal("")),
    subject: z.string().max(300).optional(),
    message: z.string().max(5000).optional(),
  }),
});
