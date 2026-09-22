import { Edit3, Shield, UserCog, Plus, KeyRound, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey, getListRolesQueryKey, getListUsersQueryKey, useCreateRole, useCreateUser, useDeleteRole, useGetAuthSession, useListRoles, useListSalespersons, useListUsers, useUpdateRole, useUpdateUser, type AppRole, type CrmUser, type CrmUserUpdate, type CrmUserInput, type RoleInput } from '@workspace/api-client-react';
import { ErrorState, formatDate, initials, SkeletonPanel } from '@/components/CrmShell';
import { EmptyState, Modal, SearchField } from '@/components/DataTools';

export default function Users() {
  const client = useQueryClient();
  const session = useGetAuthSession({ query: { queryKey: getGetAuthSessionQueryKey(), retry: false } });
  const canManageUsers = session.data?.user.role === 'admin' || session.data?.user.permissions?.includes('users.manage');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<CrmUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const query = useListUsers({ query: { queryKey: getListUsersQueryKey(), staleTime: 30_000 } });
  const salespersons = useListSalespersons({ query: { queryKey: ['users-salespersons'], staleTime: 60_000 } });
  const update = useUpdateUser();
  const create = useCreateUser();
  const roles = useListRoles({ query: { queryKey: getListRolesQueryKey(), staleTime: 30_000 } });
  
  const users = (query.data ?? []).filter((user) => `${user.username} ${user.fullName ?? ''} ${user.mobile ?? ''} ${user.role} ${user.salespersonName ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  
  const save = (id: number, data: CrmUserUpdate) => update.mutate({ id, data }, { onSuccess: () => { setEditing(null); client.invalidateQueries({ queryKey: getListUsersQueryKey() }); } });
  const toggle = (user: CrmUser) => save(user.id, { active: !user.active });
  const handleCreate = (data: CrmUserInput) => create.mutate({ data }, { onSuccess: () => { setCreating(false); client.invalidateQueries({ queryKey: getListUsersQueryKey() }); } });
  
  return (
    <section className="data-page">
      <div className="page-intro">
        <div>
          <div className="eyebrow">کنترل دسترسی</div>
          <h2>کاربران CRM</h2>
          <p>نقش، تخصیص فروش و وضعیت دسترسی اعضای تیم را در یک نگاه مدیریت کنید.</p>
        </div>
        <div className="data-summary">
          <Shield size={17} />
          <span>کاربر فعال</span>
          <strong data-testid="text-active-users">{(query.data ?? []).filter((user) => user.active).length.toLocaleString('fa-IR')}</strong>
        </div>
      </div>
      
      <div className="toolbar" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <SearchField value={search} onChange={setSearch} placeholder="جست‌وجوی نام کاربری، نقش یا کارشناس..." testId="users" />
        <div style={{ display: 'flex', gap: 8 }}>
        {session.data?.user.role === 'admin' ? <button className="btn btn-ghost" onClick={() => setRolesOpen(true)} data-testid="button-manage-roles"><KeyRound size={15} /> نقش‌ها و دسترسی‌ها</button> : null}
        {canManageUsers ? <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="button-create-user">
          <Plus size={15} />
          کاربر جدید
        </button> : null}
        </div>
      </div>
      
      {query.isLoading ? <SkeletonPanel rows={5} /> : query.isError ? <ErrorState onRetry={() => query.refetch()} /> : (
        <div className="data-table-wrap" style={{ marginTop: 14 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>کاربر</th>
                <th>نقش</th>
                <th>موبایل</th>
                <th>کارشناس فروش</th>
                <th>وضعیت</th>
                <th>شروع فعالیت</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              {users.length ? users.map((user) => (
                <tr key={user.id} data-testid={`row-user-${user.id}`}>
                  <td>
                    <span className="avatar" style={{ display: 'inline-grid', width: 30, height: 30, marginLeft: 8, verticalAlign: 'middle' }}>
                      {initials(user.fullName || user.username)}
                    </span>
                    <span className="primary-cell">{user.fullName || 'بدون نام'}</span>
                    <span className="secondary-cell mono" dir="ltr" style={{ display: 'inline-block', marginRight: 5 }}>{user.username}</span>
                  </td>
                  <td>
                    <span className="inline-badge gold">{user.roleName || roleLabel(user.role)}</span>
                  </td>
                  <td className="mono" dir="ltr">{user.mobile || '—'}</td>
                  <td>{user.salespersonName || 'بدون تخصیص'}</td>
                  <td>
                    <button className={`switch ${user.active ? 'on' : ''}`} disabled={!canManageUsers} onClick={() => toggle(user)} aria-label={user.active ? 'غیرفعال کردن کاربر' : 'فعال کردن کاربر'} data-testid={`button-toggle-user-${user.id}`}>
                      <span />
                    </button>
                    <span className={`inline-badge ${user.active ? 'active' : 'inactive'}`} style={{ marginRight: 8 }}>
                      {user.active ? 'فعال' : 'غیرفعال'}
                    </span>
                  </td>
                  <td className="secondary-cell">{formatDate(user.createdAt)}</td>
                  <td>
                    <button className="table-action" disabled={!canManageUsers} onClick={() => setEditing(user)} data-testid={`button-edit-user-${user.id}`}>
                      <Edit3 size={13} />ویرایش
                    </button>
                  </td>
                </tr>
              )) : (
                <tr>
                    <td colSpan={7}>
                    <EmptyState title="کاربری مطابق جست‌وجو پیدا نشد" description="عبارت جست‌وجو را تغییر دهید." />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      
      {editing && (
        <UserEditForm 
          user={editing} 
          roles={roles.data?.roles ?? []}
          salespersons={salespersons.data ?? []} 
          pending={update.isPending} 
          onClose={() => setEditing(null)} 
          onSave={(data) => save(editing.id, data)} 
        />
      )}
      {rolesOpen && roles.data ? <RoleManager roles={roles.data.roles} permissions={roles.data.availablePermissions} onClose={() => setRolesOpen(false)} /> : null}
      
      {creating && (
        <UserCreateForm 
          roles={roles.data?.roles ?? []}
          salespersons={salespersons.data ?? []} 
          pending={create.isPending} 
          onClose={() => setCreating(false)} 
          onSave={handleCreate} 
        />
      )}
    </section>
  );
}

function roleLabel(role: string) {
  const roles: Record<string, string> = { admin: 'مدیر سیستم', registrar: 'ثبت‌نام‌کننده', salesperson: 'کارشناس فروش' };
  return roles[role] ?? role;
}

function UserEditForm({ user, roles, salespersons, pending, onClose, onSave }: { user: CrmUser; roles: AppRole[]; salespersons: { id: number; name: string }[]; pending: boolean; onClose: () => void; onSave: (data: CrmUserUpdate) => void }) {
  const [form, setForm] = useState({ username: user.username, fullName: user.fullName ?? '', mobile: user.mobile ?? '', telegramId: user.telegramId ?? '', password: '', confirmPassword: '', role: user.role, salespersonId: user.salespersonId ? String(user.salespersonId) : '', active: user.active });
  const [formError, setFormError] = useState('');
  
  const submit = (event: FormEvent) => { 
    event.preventDefault();
    if (form.password && form.password.length < 8) {
      setFormError('رمز عبور باید حداقل ۸ نویسه باشد.');
      return;
    }
    if (form.password !== form.confirmPassword) {
      setFormError('رمز عبور با تکرار آن مطابقت ندارد.');
      return;
    }
    setFormError('');
    onSave({
      username: form.username.trim(),
      fullName: form.fullName.trim() || null,
      mobile: form.mobile.trim() || null,
      telegramId: form.telegramId.trim() || null,
      ...(form.password ? { password: form.password } : {}),
      role: form.role,
      salespersonId: form.salespersonId ? Number(form.salespersonId) : null,
      active: form.active,
    });
  };
  
  return (
    <Modal title={`ویرایش ${user.username}`} eyebrow="حساب کاربری" onClose={onClose} testId="user-form">
      <form onSubmit={submit}>
        {formError && <div className="profile-form-error" data-testid="error-user-validation">{formError}</div>}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="user-username-edit">نام کاربری</label>
            <input id="user-username-edit" value={form.username} minLength={3} maxLength={100} pattern="[A-Za-z0-9._\-]+" dir="ltr" autoComplete="off" required onChange={(event) => setForm({ ...form, username: event.target.value })} data-testid="input-user-username" />
          </div>
          <div className="field">
            <label htmlFor="user-telegram">آیدی تلگرام</label>
            <input id="user-telegram" value={form.telegramId} maxLength={100} dir="ltr" onChange={(event) => setForm({ ...form, telegramId: event.target.value })} placeholder="@username" data-testid="input-user-telegram" />
          </div>
          <div className="field">
            <label htmlFor="user-mobile-edit">شماره موبایل</label>
            <input id="user-mobile-edit" value={form.mobile} maxLength={30} dir="ltr" onChange={(event) => setForm({ ...form, mobile: event.target.value })} placeholder="09xxxxxxxxx" data-testid="input-user-mobile" />
          </div>
          <div className="field full">
            <label htmlFor="user-full-name">نام نمایشی</label>
            <input id="user-full-name" value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} data-testid="input-user-full-name" />
          </div>
          <div className="field">
            <label htmlFor="user-role">نقش</label>
            <select id="user-role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} data-testid="select-user-role">
              {roles.map((role) => <option key={role.slug} value={role.slug}>{role.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="user-salesperson">تخصیص کارشناس فروش</label>
            <select id="user-salesperson" value={form.salespersonId} onChange={(event) => setForm({ ...form, salespersonId: event.target.value })} data-testid="select-user-salesperson">
              <option value="">بدون تخصیص</option>
              {salespersons.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="user-password-edit">رمز عبور جدید</label>
            <input id="user-password-edit" type="password" value={form.password} minLength={form.password ? 8 : undefined} maxLength={200} dir="ltr" autoComplete="new-password" onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="برای حفظ رمز فعلی خالی بگذارید" data-testid="input-user-password" />
          </div>
          <div className="field">
            <label htmlFor="user-password-confirm">تکرار رمز عبور جدید</label>
            <input id="user-password-confirm" type="password" value={form.confirmPassword} maxLength={200} dir="ltr" autoComplete="new-password" onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} data-testid="input-user-confirm-password" />
          </div>
          <div className="field full">
            <label className="boolean-field" style={{ justifyContent: 'flex-start', gap: 10 }}>
              <input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} data-testid="checkbox-user-active" />
              دسترسی کاربر فعال باشد
            </label>
          </div>
        </div>
        
        <div className="form-footer" style={{ marginTop: 24 }}>
          <button className="btn btn-primary" type="submit" disabled={pending} data-testid="button-save-user">
            <UserCog size={15} />
            {pending ? 'در حال ذخیره...' : 'ذخیره کاربر'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onClose} data-testid="button-cancel-user">انصراف</button>
        </div>
      </form>
    </Modal>
  );
}

function UserCreateForm({ roles, salespersons, pending, onClose, onSave }: { roles: AppRole[]; salespersons: { id: number; name: string }[]; pending: boolean; onClose: () => void; onSave: (data: CrmUserInput) => void }) {
  const [form, setForm] = useState({ username: '', password: '', fullName: '', mobile: '', role: roles.find((role) => role.slug === 'salesperson')?.slug ?? roles[0]?.slug ?? '', salespersonId: '', active: true });
  const [error, setError] = useState('');
  
  const submit = (event: FormEvent) => { 
    event.preventDefault(); 
    
    if (form.username.length < 3) {
      setError('نام کاربری باید حداقل ۳ حرف باشد.');
      return;
    }
    
    if (form.password.length < 8) {
      setError('رمز عبور باید حداقل ۸ نویسه باشد.');
      return;
    }
    
    setError('');
    onSave({ 
      username: form.username,
      password: form.password,
      fullName: form.fullName.trim() || null, 
      mobile: form.mobile.trim() || null,
      role: form.role, 
      salespersonId: form.salespersonId ? Number(form.salespersonId) : null, 
      active: form.active 
    }); 
  };
  
  return (
    <Modal title="ایجاد کاربر جدید" eyebrow="حساب کاربری" onClose={onClose} testId="user-create-form">
      <form onSubmit={submit}>
        {error && <div style={{ color: '#a35a51', fontSize: 12, marginBottom: 16, padding: '10px 14px', background: '#fff7f5', border: '1px solid #efd5d1', borderRadius: 8 }}>{error}</div>}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="user-username">نام کاربری *</label>
            <input id="user-username" dir="ltr" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="مثال: admin" required data-testid="input-create-username" />
          </div>
          <div className="field">
            <label htmlFor="user-password">رمز عبور *</label>
            <input type="password" id="user-password" dir="ltr" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required minLength={8} data-testid="input-create-password" />
          </div>
          <div className="field full">
            <label htmlFor="user-full-name">نام نمایشی</label>
            <input id="user-full-name" value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} placeholder="مثال: علی احمدی" data-testid="input-create-full-name" />
          </div>
          <div className="field full">
            <label htmlFor="user-mobile-create">شماره موبایل</label>
            <input id="user-mobile-create" value={form.mobile} maxLength={30} dir="ltr" onChange={(event) => setForm({ ...form, mobile: event.target.value })} placeholder="09xxxxxxxxx" data-testid="input-create-mobile" />
          </div>
          <div className="field">
            <label htmlFor="user-role">نقش</label>
            <select id="user-role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} data-testid="select-create-role">
              {roles.map((role) => <option key={role.slug} value={role.slug}>{role.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="user-salesperson">تخصیص کارشناس فروش</label>
            <select id="user-salesperson" value={form.salespersonId} onChange={(event) => setForm({ ...form, salespersonId: event.target.value })} data-testid="select-create-salesperson">
              <option value="">بدون تخصیص</option>
              {salespersons.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </div>
          <div className="field full">
            <label className="boolean-field" style={{ justifyContent: 'flex-start', gap: 10 }}>
              <input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} data-testid="checkbox-create-active" />
              دسترسی کاربر فعال باشد
            </label>
          </div>
        </div>
        
        <div className="form-footer" style={{ marginTop: 24 }}>
          <button className="btn btn-primary" type="submit" disabled={pending} data-testid="button-submit-create-user">
            <UserCog size={15} />
            {pending ? 'در حال ایجاد...' : 'ایجاد کاربر'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onClose} data-testid="button-cancel-create-user">انصراف</button>
        </div>
      </form>
    </Modal>
  );
}

const permissionLabels: Record<string, string> = {
  'dashboard.view': 'مشاهده داشبورد',
  'customers.view': 'مشاهده مشتریان',
  'customers.create': 'ثبت مشتری',
  'customers.update': 'ویرایش مشتری',
  'customers.delete': 'حذف مشتری',
  'calls.view': 'مشاهده تماس‌ها',
  'calls.create': 'ثبت تماس',
  'consultations.view': 'مشاهده مشاوره‌ها',
  'consultations.create': 'ثبت مشاوره',
  'consultations.update': 'ویرایش مشاوره',
  'reminders.view': 'مشاهده یادآورها',
  'reminders.manage': 'مدیریت یادآورها',
  'loan_plans.view': 'مشاهده طرح‌های تسهیلاتی',
  'loan_plans.manage': 'مدیریت طرح‌های تسهیلاتی',
  'allocation_programs.view': 'مشاهده برنامه‌های تخصیص',
  'allocation_programs.manage': 'مدیریت برنامه‌های تخصیص',
  'users.view': 'مشاهده کاربران',
  'users.manage': 'مدیریت کاربران و نقش‌ها',
  'notifications.view': 'مشاهده تنظیمات و گزارش اعلان‌ها',
  'notifications.manage': 'مدیریت اعلان‌ها',
  'database.manage': 'دانلود و جایگزینی دیتابیس',
};

function RoleManager({ roles, permissions, onClose }: { roles: AppRole[]; permissions: string[]; onClose: () => void }) {
  const client = useQueryClient();
  const create = useCreateRole();
  const update = useUpdateRole();
  const remove = useDeleteRole();
  const [selectedSlug, setSelectedSlug] = useState(roles[0]?.slug ?? '');
  const selected = roles.find((role) => role.slug === selectedSlug);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<RoleInput>({
    slug: '',
    name: '',
    description: null,
    customerScope: 'all',
    permissions: [],
  });

  const loadRole = (role: AppRole) => {
    setSelectedSlug(role.slug);
    setCreating(false);
    setForm({
      slug: role.slug,
      name: role.name,
      description: role.description,
      customerScope: role.customerScope,
      permissions: role.permissions,
    });
  };
  const newRole = () => {
    setSelectedSlug('');
    setCreating(true);
    setForm({ slug: '', name: '', description: null, customerScope: 'all', permissions: [] });
  };
  const refresh = () => client.invalidateQueries({ queryKey: getListRolesQueryKey() });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (creating) {
      create.mutate({ data: form }, { onSuccess: (role) => { setCreating(false); setSelectedSlug(role.slug); refresh(); } });
    } else if (selected) {
      update.mutate({
        slug: selected.slug,
        data: {
          name: form.name,
          description: form.description,
          customerScope: form.customerScope,
          permissions: form.permissions,
        },
      }, { onSuccess: refresh });
    }
  };
  const togglePermission = (permission: string) => setForm((current) => ({
    ...current,
    permissions: current.permissions.includes(permission)
      ? current.permissions.filter((item) => item !== permission)
      : [...current.permissions, permission],
  }));
  const deleteSelected = () => {
    if (!selected || selected.system || !window.confirm(`نقش «${selected.name}» حذف شود؟`)) return;
    remove.mutate({ slug: selected.slug }, {
      onSuccess: () => {
        const fallback = roles.find((role) => role.slug !== selected.slug);
        if (fallback) loadRole(fallback);
        refresh();
      },
    });
  };
  const locked = selected?.slug === 'admin';
  return (
    <Modal title="نقش‌ها و دسترسی‌ها" eyebrow="کنترل کامل دسترسی" onClose={onClose} testId="role-manager">
      <div className="role-manager-layout">
        <div className="role-manager-sidebar">
          <button className="btn btn-primary" type="button" onClick={newRole}><Plus size={14} /> نقش جدید</button>
          {roles.map((role) => <button key={role.slug} type="button" className={`btn ${selectedSlug === role.slug ? 'btn-gold' : 'btn-ghost'}`} onClick={() => loadRole(role)}>{role.name}</button>)}
        </div>
        <form className="role-manager-form" onSubmit={submit}>
          <div className="role-manager-scroll">
            {(create.isError || update.isError || remove.isError) ? <div className="profile-form-error">ذخیره نقش انجام نشد. اگر نقش به کاربری متصل است، ابتدا نقش آن کاربر را تغییر دهید.</div> : null}
            <div className="form-grid role-manager-fields">
              <div className="field"><label>عنوان نقش</label><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required disabled={locked} data-testid="input-role-name" /></div>
              <div className="field"><label>شناسه نقش</label><input dir="ltr" value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value.toLowerCase() })} pattern="[a-z][a-z0-9_-]{2,49}" required disabled={!creating} data-testid="input-role-slug" /></div>
              <div className="field full"><label>توضیحات</label><input value={form.description ?? ''} onChange={(event) => setForm({ ...form, description: event.target.value || null })} disabled={locked} /></div>
              <div className="field full"><label>محدوده مشتریان</label><select value={form.customerScope} onChange={(event) => setForm({ ...form, customerScope: event.target.value as 'all' | 'assigned' })} disabled={locked} data-testid="select-role-scope"><option value="all">همه مشتریان</option><option value="assigned">فقط مشتریان تخصیص‌یافته به کاربر</option></select></div>
            </div>
            <div className="role-manager-permission-head"><strong>دسترسی‌ها</strong><p className="secondary-cell">هر موردی که فعال باشد، در منو نمایش داده می‌شود و API نیز همان مجوز را کنترل می‌کند.</p></div>
            <div className="role-manager-permissions">
              {permissions.map((permission) => <label className="boolean-field role-permission" key={permission}><input type="checkbox" checked={locked || form.permissions.includes(permission)} onChange={() => togglePermission(permission)} disabled={locked} /><span>{permissionLabels[permission] ?? permission}</span></label>)}
            </div>
          </div>
          <div className="form-footer role-manager-footer">
            <button className="btn btn-primary" type="submit" disabled={locked || create.isPending || update.isPending}><Shield size={15} /> {creating ? 'ایجاد نقش' : 'ذخیره دسترسی‌ها'}</button>
            {!creating && selected && !selected.system ? <button className="btn btn-danger" type="button" onClick={deleteSelected} disabled={remove.isPending}><Trash2 size={14} /> حذف نقش</button> : null}
          </div>
        </form>
      </div>
    </Modal>
  );
}