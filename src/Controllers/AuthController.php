<?php

declare(strict_types=1);

namespace Blanket\Controllers;

use Blanket\Auth\Authenticator;
use Blanket\Auth\Jwt;
use Blanket\Auth\Password;
use Blanket\Http\Request;
use Blanket\Http\Response;
use Blanket\Repositories\UserRepository;

final class AuthController
{
    public function __construct(private readonly UserRepository $users = new UserRepository())
    {
    }

    public function login(Request $request): void
    {
        $username = (string) $request->input('username', '');
        $password = (string) $request->input('password', '');

        if ($username === '' || $password === '') {
            Response::error('Username and password are required', 422);
        }

        $user = $this->users->findByUsername($username);
        if ($user === null || !Password::verify($password, $user['password_hash'])) {
            Response::error('Invalid credentials', 401);
        }
        if (!$user['enabled']) {
            Response::error('This account is disabled', 403);
        }

        $token = Jwt::issue($user);
        Response::json([
            'token' => $token,
            'user' => [
                'id' => $user['id'],
                'username' => $user['username'],
                'display_name' => $user['display_name'],
                'is_admin' => $user['is_admin'],
            ],
        ]);
    }

    /**
     * Issues a fresh token (new full TTL_SECONDS window) for whoever the
     * caller's CURRENT token already proves them to be -- the client-side
     * half of "remember indefinitely": app.js calls this on every boot
     * when it finds a still-valid stored token, so a returning visitor's
     * session keeps sliding forward instead of ever hitting its original
     * expiry. Authenticator::resolve() already rejects an expired/invalid/
     * missing token by resolving to anonymous, same as any other endpoint
     * -- no separate leniency here, only a genuinely unexpired token can
     * be renewed, matching Fernando's requirement that a truly abandoned
     * token still dies on schedule.
     *
     * Re-fetches the account by username rather than trusting the token's
     * embedded claims for the reissue -- a token issued before an account
     * was disabled (or soft-deleted) must not keep renewing itself forever
     * on stale claims; findByUsername() already filters both.
     */
    public function renew(Request $request): void
    {
        $current = Authenticator::resolve($request);
        if ($current->isAnonymous()) {
            Response::error('Authentication required', 401);
        }

        $user = $this->users->findByUsername($current->username);
        if ($user === null || !$user['enabled']) {
            Response::error('Authentication required', 401);
        }

        $token = Jwt::issue($user);
        Response::json([
            'token' => $token,
            'user' => [
                'id' => $user['id'],
                'username' => $user['username'],
                'display_name' => $user['display_name'],
                'is_admin' => $user['is_admin'],
            ],
        ]);
    }
}
