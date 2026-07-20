<?php

declare(strict_types=1);

namespace Blanket\Controllers;

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
}
