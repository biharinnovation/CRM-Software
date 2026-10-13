"use client";

import { useState, useEffect } from "react";
import { Ban, Loader2 } from "lucide-react";

/**
 * Confirm marking an invoice inactive — the replacement for deleting one.
 *
 * Nothing is removed: the invoice keeps its number and payment history, drops
 * out of every total, and stays visible to Owner/Admin, who can reactivate it.
 * The optional reason is stored so a voided invoice can be explained later.
 */
export default function DeactivateInvoiceModal({ isOpen, invoiceNumber, onClose, onConfirm, isPending = false }) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (isOpen) setReason("");
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={isPending ? undefined : onClose} />
      <div className="relative bg-white dark:bg-slate-950 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center shrink-0">
            <Ban className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-50">
              Mark {invoiceNumber || "invoice"} inactive?
            </h3>
          </div>
        </div>

        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Reason (optional)</label>
        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Raised against the wrong project"
          maxLength={1000}
          className="mt-1.5 w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-50 focus:ring-2 focus:ring-[#5542F6] focus:border-transparent outline-none resize-none"
        />

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(reason.trim())}
            disabled={isPending}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-xl disabled:opacity-60"
          >
            {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
            Mark inactive
          </button>
        </div>
      </div>
    </div>
  );
}
