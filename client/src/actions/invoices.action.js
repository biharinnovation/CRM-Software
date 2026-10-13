"use server";

import {
  getInvoicesAPI,
  getInvoiceAPI,
  getInvoicesByProjectAPI,
  getPreviousDueSuggestionAPI,
  getMyInvoicesAPI,
  createInvoiceAPI,
  updateInvoiceAPI,
  deactivateInvoiceAPI,
  reactivateInvoiceAPI,
  getInvoiceConfigAPI,
  sendInvoiceEmailAPI,
  addInvoicePaymentAPI,
  deleteInvoicePaymentAPI,
} from "@/lib/api";
import { getToken } from "@/lib/session";


export async function getInvoices(params = {}) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await getInvoicesAPI(params, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to fetch invoices" };
  }
}

export async function getInvoice(id) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await getInvoiceAPI(id, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to fetch invoice" };
  }
}

export async function getInvoicesByProject(projectId) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await getInvoicesByProjectAPI(projectId, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to fetch project invoices" };
  }
}

export async function getPreviousDueSuggestion(projectId) {
  const token = await getToken();
  if (!token) return { success: false, data: { previousDueAmount: 0 } };
  try {
    const res = await getPreviousDueSuggestionAPI(projectId, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, data: { previousDueAmount: 0 } };
  } catch {
    return { success: false, data: { previousDueAmount: 0 } };
  }
}

export async function createInvoice(data) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await createInvoiceAPI(data, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to create invoice" };
  }
}

export async function updateInvoice(id, data) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await updateInvoiceAPI(id, data, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to update invoice" };
  }
}

export async function getInvoiceConfig() {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await getInvoiceConfigAPI(token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to fetch invoice config" };
  }
}

export async function deactivateInvoice(id, reason = null) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await deactivateInvoiceAPI(id, reason, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to mark invoice inactive" };
  }
}

export async function reactivateInvoice(id) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await reactivateInvoiceAPI(id, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to reactivate invoice" };
  }
}

export async function getMyInvoices() {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await getMyInvoicesAPI(token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to fetch invoices" };
  }
}

/** Record money received against an invoice. */
export async function addInvoicePayment(id, data) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await addInvoicePaymentAPI(id, data, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to record payment" };
  }
}

/** Remove a wrongly-entered receipt. The invoice re-derives from what is left. */
export async function deleteInvoicePayment(id, paymentId) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await deleteInvoicePaymentAPI(id, paymentId, token);
    if (res.success) return { success: true, data: res.data };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to remove payment" };
  }
}

/** Email the invoice to the client. */
export async function sendInvoiceEmail(id, data) {
  const token = await getToken();
  if (!token) return { success: false, error: "Not authenticated" };
  try {
    const res = await sendInvoiceEmailAPI(id, data, token);
    if (res.success) return { success: true, data: res.data, message: res.message };
    return { success: false, error: res.message };
  } catch (err) {
    return { success: false, error: err.message || "Failed to send invoice" };
  }
}
