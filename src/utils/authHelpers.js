/**
 * Admin resolution for calling service without main-backend Role DB.
 * JWT from main backend may include platformSuperUser on the user document
 * when validated via shared User collection; here we use token claims only.
 */
export function userIsAdmin(user) {
  if (!user) return false;
  return Boolean(user.platformSuperUser || user.isAdmin);
}
