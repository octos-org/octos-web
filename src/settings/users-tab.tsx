import { useState, useEffect, useCallback } from "react";
import {
  Users,
  UserPlus,
  Trash2,
  Mail,
  Shield,
  Plus,
  X,
  Loader2,
} from "lucide-react";
import {
  getAdminUsers,
  createAdminUser,
  deleteAdminUser,
  getAllowedEmails,
  addAllowedEmail,
  removeAllowedEmail,
  formatSettingsError,
  type AdminUser,
  type AllowedEmail,
  type Profile,
} from "./settings-api";
import { ConfirmDialog } from "./confirm-dialog";

// ── Create Sub-Account form ──

function deriveSubAccountId(email: string): string {
  const localPart = email.split("@")[0] ?? "user";
  const cleaned = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `user-${Date.now()}`;
}

function CreateSubAccountForm({
  parentProfileId,
  onCreated,
}: {
  parentProfileId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setUserId("");
    setEmail("");
    setDisplayName("");
    setNote("");
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !displayName.trim()) return;
    setSaving(true);
    setError(null);
    const subAccountId = userId.trim() || deriveSubAccountId(email.trim());
    try {
      await createAdminUser(parentProfileId, {
        email: email.trim(),
        name: displayName.trim(),
        sub_account_id: subAccountId,
        public_subdomain: subAccountId,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      reset();
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(formatSettingsError(err, "Failed to create sub-account. The server may have rejected the request."));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-dim transition"
      >
        <UserPlus size={14} />
        Create Sub-Account
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl bg-surface-container/60 p-5 space-y-4 border border-border/30">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-text-strong">New Sub-Account</h4>
        <button
          type="button"
          onClick={() => { setOpen(false); reset(); }}
          className="rounded-lg p-1.5 text-muted hover:bg-surface-dark/50 hover:text-text-strong transition"
        >
          <X size={14} />
        </button>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted">User ID</label>
        <input
          type="text"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="Leave blank to derive from email"
          className="w-full rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted">
          Email <span className="text-red-400">*</span>
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          required
          className="w-full rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
        />
        <p className="mt-1 text-[11px] text-muted/60">For web client login</p>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted">
          Display Name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Display name"
          required
          className="w-full rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted">Note</label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note"
          className="w-full rounded-xl bg-surface-dark/50 px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
        />
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={saving || !email.trim() || !displayName.trim()}
          className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Create
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); reset(); }}
          className="rounded-xl px-4 py-2.5 text-sm font-medium text-muted hover:text-text-strong hover:bg-surface-dark/50 transition"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Allowed Emails section ──

function AllowedEmailsSection() {
  const [emails, setEmails] = useState<AllowedEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingEmail, setRemovingEmail] = useState<string | null>(null);
  const [pendingRemoveEmail, setPendingRemoveEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getAllowedEmails();
      setEmails(data);
    } catch (err) {
      setError(formatSettingsError(err, "Failed to load allowed emails."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAllowedEmails()
      .then((data) => {
        if (!cancelled) {
          setEmails(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(formatSettingsError(err, "Failed to load allowed emails."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await addAllowedEmail(newEmail.trim());
      setNewEmail("");
      await refresh();
    } catch (err) {
      setError(formatSettingsError(err, "Failed to add email to the allowlist."));
    } finally {
      setAdding(false);
    }
  };

  const confirmRemove = async () => {
    const email = pendingRemoveEmail;
    if (!email) return;
    setPendingRemoveEmail(null);
    setRemovingEmail(email);
    setError(null);
    try {
      await removeAllowedEmail(email);
      await refresh();
    } catch (err) {
      setError(formatSettingsError(err, `Failed to remove '${email}' from the allowlist.`));
    } finally {
      setRemovingEmail(null);
    }
  };

  return (
    <div className="glass-section rounded-lg p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Shield size={20} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-text-strong">Allowed Emails</h3>
          <p className="text-xs text-muted">
            These addresses can complete OTP signup later. Registration happens on first successful login.
          </p>
        </div>
      </div>

      {/* Add email form */}
      <form onSubmit={handleAdd} className="flex items-center gap-2 mb-4">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="user@example.com"
          className="flex-1 rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
        />
        <button
          type="submit"
          disabled={adding || !newEmail.trim()}
          className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
        >
          {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add
        </button>
      </form>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 size={18} className="animate-spin text-muted" />
        </div>
      ) : emails.length === 0 ? (
        <div className="rounded-xl bg-surface-dark/50 px-6 py-8 text-center">
          <Mail size={28} className="mx-auto mb-2 text-muted/40" />
          <p className="text-sm text-muted">No allowlisted emails yet</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {emails.map((entry) => (
            <div
              key={entry.email}
              className="flex items-center justify-between rounded-xl bg-surface-container/60 px-4 py-3 border border-transparent hover:border-border transition"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Mail size={14} className="shrink-0 text-muted" />
                <span className="text-sm text-text truncate">{entry.email}</span>
              </div>
              <button
                onClick={() => setPendingRemoveEmail(entry.email)}
                disabled={removingEmail === entry.email}
                className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-400 transition"
                title={`Remove ${entry.email}`}
              >
                {removingEmail === entry.email ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={pendingRemoveEmail != null}
        title="Remove Allowed Email"
        body={
          pendingRemoveEmail
            ? `Remove '${pendingRemoveEmail}' from the allowlist?`
            : "Remove this email from the allowlist?"
        }
        confirmLabel="Remove Email"
        variant="danger"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingRemoveEmail(null)}
      />
    </div>
  );
}

// ── Users Tab (main export) ──

export function UsersTab({ profile }: { profile: Profile }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteUser, setPendingDeleteUser] = useState<AdminUser | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getAdminUsers();
      setUsers(data);
    } catch (err) {
      setError(formatSettingsError(err, "Failed to load users."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAdminUsers()
      .then((data) => {
        if (!cancelled) setUsers(data);
      })
      .catch((err) => {
        if (!cancelled) setError(formatSettingsError(err, "Failed to load users."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const confirmDeleteUser = async () => {
    const user = pendingDeleteUser;
    if (!user) return;
    setPendingDeleteUser(null);
    setDeletingUserId(user.id);
    setError(null);
    try {
      await deleteAdminUser(user.id);
      await refresh();
    } catch (err) {
      setError(formatSettingsError(err, `Failed to delete account '${user.email}'.`));
    } finally {
      setDeletingUserId(null);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "\u2014";
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="space-y-6">
      {/* Users list */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Users size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">Users</h3>
              <p className="text-xs text-muted">
                {users.length > 0
                  ? `${users.length} registered account${users.length === 1 ? "" : "s"}`
                  : "Manage registered accounts"}
              </p>
            </div>
          </div>
        </div>

        {/* Create sub-account */}
        <div className="mb-5">
          <CreateSubAccountForm parentProfileId={profile.id} onCreated={refresh} />
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3 text-xs text-red-300">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 size={20} className="animate-spin text-muted" />
          </div>
        ) : users.length === 0 ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-10 text-center">
            <Users size={32} className="mx-auto mb-3 text-muted/40" />
            <p className="text-sm text-muted">No registered accounts yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Table header */}
            <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_80px_90px_90px_40px] gap-3 px-4 py-2">
              <span className="text-[11px] font-medium text-muted uppercase tracking-wider">Name</span>
              <span className="text-[11px] font-medium text-muted uppercase tracking-wider">Email</span>
              <span className="text-[11px] font-medium text-muted uppercase tracking-wider">Role</span>
              <span className="text-[11px] font-medium text-muted uppercase tracking-wider">Created</span>
              <span className="text-[11px] font-medium text-muted uppercase tracking-wider">Last Login</span>
              <span />
            </div>

            {/* User rows */}
            {users.map((u) => (
              <div
                key={u.id}
                className="sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_80px_90px_90px_40px] sm:items-center gap-3 rounded-xl bg-surface-container/60 px-4 py-3 border border-transparent hover:border-border transition"
              >
                {/* Name + ID (stacked on mobile) */}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-strong truncate">{u.name || u.id}</p>
                  <p className="text-[11px] text-muted/60 font-mono truncate">{u.id}</p>
                </div>
                {/* Email */}
                <p className="text-sm text-text truncate">{u.email}</p>
                {/* Role badge */}
                <div>
                  <span className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                    u.role === "admin"
                      ? "bg-accent/15 text-accent"
                      : "bg-surface-dark/60 text-muted"
                  }`}>
                    {u.role}
                  </span>
                </div>
                {/* Created */}
                <p className="text-xs text-muted">{formatDate(u.created_at)}</p>
                {/* Last Login */}
                <p className="text-xs text-muted">{formatDate(u.last_login)}</p>
                {/* Delete */}
                <div className="flex justify-end">
                  <button
                    onClick={() => setPendingDeleteUser(u)}
                    disabled={deletingUserId === u.id}
                    className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40 transition"
                    title={`Delete ${u.email}`}
                  >
                    {deletingUserId === u.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Allowed emails */}
      <AllowedEmailsSection />
      <ConfirmDialog
        open={pendingDeleteUser != null}
        title="Delete Account"
        body={
          pendingDeleteUser
            ? `Delete account '${pendingDeleteUser.email}'? This will also delete the profile and stop its gateway.`
            : "Delete this account?"
        }
        confirmLabel="Delete Account"
        variant="danger"
        onConfirm={() => void confirmDeleteUser()}
        onCancel={() => setPendingDeleteUser(null)}
      />
    </div>
  );
}
