# Group HQ read bridge for Property Predator leads

The optional `GET /api/group-hq/crm/leads?brand=pp` endpoint returns at most 50
Property Predator contact rows per request. A continuation cursor requests the
next page. It exposes a fixed allowlist: contact ID/name/source/lifecycle,
latest open opportunity stage, next open task time, last activity time, owner
ID and updated time. It cannot write CRM data or send a message. The MHP host
does not mount the endpoint.

Four Render variables enable the bridge on the Property Predator web service:

- `R72_GROUP_HQ_CRM_TOKEN`: a distinct random service secret of at least 32
  characters. Copy the same value to Group HQ as `R72_CRM_TOKEN`.
- `R72_GROUP_HQ_CRM_PP_ORGANIZATION_ID`: the exact Property Predator organisation.
- `R72_GROUP_HQ_CRM_PP_WORKSPACE_ID`: the exact Growth HQ workspace.
- `R72_GROUP_HQ_CRM_OWNER_USER_ID`: an active owner of that workspace.

The service also requires `PORTAL_PRODUCT_PROFILE=property_predator_growth`.
Missing configuration leaves the endpoint absent. A partial or invalid optional
setup does not unmount the existing portal. Each read verifies the configured
owner can manage the workspace and that the workspace belongs to the configured
organisation, then runs a read-only transaction under the existing RLS policy.
Requests use `Authorization: Bearer`, are host-bound and never cached.

Release with a separate Group HQ review branch. Before connecting secrets,
confirm PP and MHP `/ready` remain healthy. After connecting, prove 401 without
the token, 400 for another brand or malformed cursor, 403 after a removed owner
membership, and 200 for an owned PP test lead. Rotate by replacing the token
on both services; remove the Group HQ token to disconnect without affecting
member CRM or checkout.
