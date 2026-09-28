-- ADR-004 §4: a gamer holds at most one ACTIVE membership. Subscriptions are intentionally unconstrained.
CREATE UNIQUE INDEX "memberships_one_active_per_gamer" ON "memberships"("gamer_profile_id") WHERE (status = 'ACTIVE');
