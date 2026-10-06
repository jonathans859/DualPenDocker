import * as api from "./api";

// Count code points like the server (pydantic), not UTF-16 units.
const cpLen = (s: string): number => [...s].length;

/**
 * Admin-only user management dialog over /api/admin/users (list, create,
 * edit display name / password / admin / active). Same <dialog> pattern as
 * the other panels; results are reported through a role="status" region.
 */
export class AdminPanel {
  private dialog: HTMLDialogElement;
  private users: api.CurrentUser[] = [];
  private editingId: number | null = null;
  private busy = false;

  private getCurrentUserId: () => number | null;

  constructor(getCurrentUserId: () => number | null) {
    this.getCurrentUserId = getCurrentUserId;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "admin-dialog";
    this.dialog.setAttribute("aria-labelledby", "admin-heading");
    this.dialog.innerHTML = `
      <h2 id="admin-heading">User administration</h2>
      <p id="admin-status" role="status" class="admin-status"></p>
      <section class="settings-section" aria-labelledby="admin-users-heading">
        <h3 id="admin-users-heading">Users</h3>
        <div class="admin-table-wrap" tabindex="0" role="region" aria-labelledby="admin-users-heading">
        <table class="admin-table">
          <thead><tr><th>Username</th><th>Display name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody id="admin-users-body"></tbody>
        </table>
        </div>
      </section>
      <form id="admin-edit-form" novalidate class="settings-section admin-form" aria-labelledby="admin-edit-heading" hidden>
        <h3 id="admin-edit-heading" tabindex="-1">Edit user</h3>
        <label>Display name <input type="text" id="admin-edit-display" required aria-describedby="admin-status" /></label>
        <label>New password (leave blank to keep) <input type="password" id="admin-edit-password" aria-describedby="admin-status" autocomplete="new-password" /></label>
        <label class="settings-checkbox-row"><input type="checkbox" id="admin-edit-admin" /> Administrator</label>
        <label class="settings-checkbox-row"><input type="checkbox" id="admin-edit-active" /> Active (can sign in)</label>
        <div class="admin-form-buttons">
          <button type="submit">Save changes</button>
          <button type="button" id="admin-edit-cancel">Cancel</button>
        </div>
      </form>
      <form id="admin-create-form" novalidate class="settings-section admin-form" aria-labelledby="admin-create-heading">
        <h3 id="admin-create-heading">Create user</h3>
        <label>Username <input type="text" id="admin-create-username" required aria-describedby="admin-status" autocomplete="off" /></label>
        <label>Display name <input type="text" id="admin-create-display" required aria-describedby="admin-status" autocomplete="off" /></label>
        <label>Initial password <input type="password" id="admin-create-password" required aria-describedby="admin-status" autocomplete="new-password" /></label>
        <div class="admin-form-buttons"><button type="submit">Create user</button></div>
      </form>
      <div class="settings-buttons">
        <button type="button" id="admin-close-btn">Close</button>
      </div>
    `;
    document.body.appendChild(this.dialog);

    this.q("#admin-close-btn").addEventListener("click", () => this.dialog.close());
    this.q("#admin-edit-cancel").addEventListener("click", () => this.closeEditor());
    this.q("#admin-create-form").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.create();
    });
    this.q("#admin-edit-form").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveEdit();
    });
    this.dialog.addEventListener("input", (e) => {
      (e.target as HTMLElement).removeAttribute("aria-invalid");
    });
    this.q("#admin-users-body").addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-user-id]");
      if (btn) this.openEditor(Number(btn.dataset.userId));
    });
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.dialog.querySelector<T>(sel)!;
  }

  private setStatus(msg: string): void {
    // Clear first so an identical repeat message is still announced.
    const el = this.q("#admin-status");
    el.textContent = "";
    window.setTimeout(() => (el.textContent = msg), 50);
  }

  /** Report a validation error and keep focus on the offending field. */
  private invalid(field: HTMLInputElement, msg: string): void {
    field.setAttribute("aria-invalid", "true");
    this.setStatus(msg);
    field.focus();
  }

  private setBusy(form: string, busy: boolean): void {
    this.q<HTMLButtonElement>(`${form} button[type="submit"]`).disabled = busy;
  }

  async open(): Promise<void> {
    if (!this.dialog.open) this.dialog.showModal();
    this.closeEditor();
    await this.refresh(true);
  }

  private async refresh(announce = false): Promise<void> {
    try {
      this.users = await api.adminListUsers();
    } catch (e) {
      this.users = [];
      this.renderRows();
      this.setStatus(`Could not load users: ${(e as Error).message}`);
      return;
    }
    this.renderRows();
    if (announce) this.setStatus(`${this.users.length} users loaded.`);
  }

  private renderRows(): void {
    const body = this.q("#admin-users-body");
    body.textContent = "";
    for (const u of this.users) {
      const tr = document.createElement("tr");
      for (const text of [
        u.username,
        u.display_name,
        u.is_admin ? "Administrator" : "User",
        u.is_active ? "Active" : "Disabled",
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      const td = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Edit";
      btn.dataset.userId = String(u.id);
      btn.setAttribute("aria-label", `Edit ${u.username}`);
      td.appendChild(btn);
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  private openEditor(id: number): void {
    const u = this.users.find((x) => x.id === id);
    if (!u) return;
    this.editingId = id;
    const self = id === this.getCurrentUserId();
    this.q<HTMLInputElement>("#admin-edit-display").value = u.display_name;
    this.q<HTMLInputElement>("#admin-edit-password").value = "";
    const admin = this.q<HTMLInputElement>("#admin-edit-admin");
    const active = this.q<HTMLInputElement>("#admin-edit-active");
    admin.checked = u.is_admin;
    active.checked = u.is_active;
    // Don't let an admin lock themselves out from this UI.
    admin.disabled = self;
    active.disabled = self;
    this.q("#admin-edit-heading").textContent = `Edit user ${u.username}`;
    this.q("#admin-edit-form").hidden = false;
    this.q("#admin-edit-heading").focus();
  }

  private closeEditor(): void {
    const form = this.q("#admin-edit-form");
    const hadFocus = form.contains(document.activeElement);
    form.hidden = true;
    const id = this.editingId;
    this.editingId = null;
    if (hadFocus) {
      const btn = this.dialog.querySelector<HTMLButtonElement>(`button[data-user-id="${id}"]`);
      (btn ?? this.q("#admin-close-btn")).focus();
    }
  }

  private async create(): Promise<void> {
    const username = this.q<HTMLInputElement>("#admin-create-username");
    const display = this.q<HTMLInputElement>("#admin-create-display");
    const password = this.q<HTMLInputElement>("#admin-create-password");
    if (this.busy) return;
    const uname = username.value.trim();
    const dname = display.value.trim();
    if (!uname) return this.invalid(username, "Username is required.");
    if (cpLen(uname) > 64) return this.invalid(username, "Username must be 64 characters or fewer.");
    if (!dname) return this.invalid(display, "Display name is required.");
    if (cpLen(dname) > 100) return this.invalid(display, "Display name must be 100 characters or fewer.");
    if (cpLen(password.value) < 8 || cpLen(password.value) > 256) {
      return this.invalid(password, "Password must be 8 to 256 characters.");
    }
    this.busy = true;
    this.setBusy("#admin-create-form", true);
    try {
      const u = await api.adminCreateUser(uname, dname, password.value);
      username.value = display.value = password.value = "";
      await this.refresh();
      this.setStatus(`Created user ${u.username}.`);
      username.focus();
    } catch (e) {
      this.setStatus(`Could not create user: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      this.setBusy("#admin-create-form", false);
    }
  }

  private async saveEdit(): Promise<void> {
    const id = this.editingId;
    const orig = this.users.find((x) => x.id === id);
    if (id === null || !orig) return;
    const changes: Parameters<typeof api.adminUpdateUser>[1] = {};
    if (this.busy) return;
    const displayEl = this.q<HTMLInputElement>("#admin-edit-display");
    const passwordEl = this.q<HTMLInputElement>("#admin-edit-password");
    const display = displayEl.value.trim();
    const password = passwordEl.value;
    if (!display) return this.invalid(displayEl, "Display name is required.");
    if (cpLen(display) > 100) return this.invalid(displayEl, "Display name must be 100 characters or fewer.");
    if (password && (cpLen(password) < 8 || cpLen(password) > 256)) {
      return this.invalid(passwordEl, "Password must be 8 to 256 characters.");
    }
    const admin = this.q<HTMLInputElement>("#admin-edit-admin").checked;
    const active = this.q<HTMLInputElement>("#admin-edit-active").checked;
    if (display !== orig.display_name) changes.display_name = display;
    if (password) changes.new_password = password;
    if (admin !== orig.is_admin) changes.is_admin = admin;
    if (active !== orig.is_active) changes.is_active = active;
    if (Object.keys(changes).length === 0) {
      this.setStatus("No changes to save.");
      return;
    }
    this.busy = true;
    this.setBusy("#admin-edit-form", true);
    try {
      await api.adminUpdateUser(id, changes);
      this.closeEditor();
      await this.refresh();
      this.dialog
        .querySelector<HTMLButtonElement>(`button[data-user-id="${id}"]`)
        ?.focus();
      this.setStatus(`Saved changes to ${orig.username}.`);
    } catch (e) {
      this.setStatus(`Could not save changes: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      this.setBusy("#admin-edit-form", false);
    }
  }
}
