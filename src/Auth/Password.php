<?php

declare(strict_types=1);

namespace Blanket\Auth;

final class Password
{
    public static function hash(string $plain): string
    {
        return password_hash($plain, PASSWORD_DEFAULT);
    }

    public static function verify(string $plain, string $hash): bool
    {
        if ($hash === '') {
            // Reserved for the id=0 anonymous sentinel, which must never
            // authenticate regardless of what's supplied.
            return false;
        }
        return password_verify($plain, $hash);
    }
}
