// The database half of the mailbox account lock (the field half is
// `lockedAccountChanges` in @yempik/core). The dashboard and the seed read it
// before deciding, and guard their writes with it again, because an OAuth
// callback may store a connection between the read and the write.

import { sql, type SQL } from 'drizzle-orm';
import { oauthConnections } from './schema.js';

/**
 * True when the mailbox has a stored OAuth connection, whatever its status:
 * its token belongs to the account it was minted for. `mailboxId` is a value
 * or a table-qualified reference such as sql`m.id`: a bare column name would
 * bind to oauth_connections inside the subquery.
 */
export function mailboxHasOAuthConnection(mailboxId: SQL | string): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${oauthConnections} c WHERE c.mailbox_id = ${mailboxId})`;
}
