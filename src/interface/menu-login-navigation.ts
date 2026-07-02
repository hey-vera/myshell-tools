import type { ProviderId } from '../providers/port.js';
import type { LoginResult } from '../commands/login.js';

export type MenuLoginOrigin =
  | { readonly kind: 'root' }
  | { readonly kind: 'accounts' }
  | { readonly kind: 'provider-accounts'; readonly provider: ProviderId }
  | { readonly kind: 'provider-account-edit'; readonly provider: ProviderId; readonly accountId: string }
  | { readonly kind: 'chat-entry'; readonly conversationId: string | 'new'; readonly provider: ProviderId }
  | { readonly kind: 'chat-retry'; readonly conversationId: string; readonly provider: ProviderId };

export type MenuLoginDestination =
  | { readonly kind: 'return'; readonly origin: MenuLoginOrigin }
  | { readonly kind: 'enter-chat'; readonly conversationId: string | 'new' }
  | { readonly kind: 'retry-chat'; readonly conversationId: string; readonly provider: ProviderId };

export function resolveMenuLoginDestination(
  origin: MenuLoginOrigin,
  result: LoginResult,
  authenticatedAfterRefresh: boolean,
): MenuLoginDestination {
  if (
    origin.kind === 'root' ||
    origin.kind === 'accounts' ||
    origin.kind === 'provider-accounts' ||
    origin.kind === 'provider-account-edit'
  ) {
    return { kind: 'return', origin };
  }

  const providerAuthenticated =
    result.outcomes.find((o) => o.provider === origin.provider)?.status === 'authenticated';

  if (providerAuthenticated && authenticatedAfterRefresh) {
    if (origin.kind === 'chat-entry') {
      return { kind: 'enter-chat', conversationId: origin.conversationId };
    }
    return {
      kind: 'retry-chat',
      conversationId: origin.conversationId,
      provider: origin.provider,
    };
  }

  return { kind: 'return', origin };
}
