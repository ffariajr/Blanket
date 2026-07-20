<?php

declare(strict_types=1);

namespace Blanket\Auth;

use Blanket\Http\Request;

/**
 * Resolves the acting user for a request. Returns the anonymous sentinel
 * (id 0) when no valid token is present -- callers decide whether that's
 * acceptable for the endpoint in question, they don't get an exception for
 * "just anonymous."
 */
final class Authenticator
{
    public static function resolve(Request $request): CurrentUser
    {
        $token = $request->bearerToken();
        if ($token === null) {
            return CurrentUser::anonymous();
        }

        try {
            $claims = Jwt::verify($token);
        } catch (\Throwable) {
            return CurrentUser::anonymous();
        }

        return new CurrentUser(
            id: (int) $claims['sub'],
            username: (string) $claims['username'],
            displayName: (string) $claims['display_name'],
            isAdmin: (bool) $claims['is_admin'],
        );
    }
}
