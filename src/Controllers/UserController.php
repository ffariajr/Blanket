<?php

declare(strict_types=1);

namespace Blanket\Controllers;

use Blanket\Auth\Authenticator;
use Blanket\Http\Request;
use Blanket\Http\Response;
use Blanket\Repositories\UserRepository;

/**
 * Supports the "share with username X" flow -- resolving a username to the
 * numeric user_id that AccessController's grant/revoke endpoints need.
 * Any authenticated user may look up any other username (not owner-scoped
 * -- the grant/revoke endpoints themselves already enforce who can act on
 * a given spreadsheet's access list; this is just a lookup).
 */
final class UserController
{
    public function __construct(private readonly UserRepository $users = new UserRepository())
    {
    }

    public function lookup(Request $request): void
    {
        $user = Authenticator::resolve($request);
        if ($user->isAnonymous()) {
            Response::error('Authentication required', 401);
        }

        $username = (string) $request->query('username', '');
        if ($username === '') {
            Response::error('username is required', 422);
        }

        $found = $this->users->findPublicByUsername($username);
        if ($found === null) {
            Response::error('Not found', 404);
        }

        Response::json($found);
    }
}
