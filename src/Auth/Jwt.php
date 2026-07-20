<?php

declare(strict_types=1);

namespace Blanket\Auth;

use Blanket\Config;
use Firebase\JWT\JWT as FirebaseJwt;
use Firebase\JWT\Key;

final class Jwt
{
    private const ALGO = 'HS256';
    private const TTL_SECONDS = 12 * 3600;

    /** @param array{id:int,username:string,display_name:string,is_admin:bool} $user */
    public static function issue(array $user): string
    {
        $now = time();
        $payload = [
            'sub' => $user['id'],
            'username' => $user['username'],
            'display_name' => $user['display_name'],
            'is_admin' => $user['is_admin'],
            'iat' => $now,
            'exp' => $now + self::TTL_SECONDS,
        ];
        return FirebaseJwt::encode($payload, self::secret(), self::ALGO);
    }

    /** @return array{sub:int,username:string,display_name:string,is_admin:bool,iat:int,exp:int} */
    public static function verify(string $token): array
    {
        $decoded = FirebaseJwt::decode($token, new Key(self::secret(), self::ALGO));
        return (array) $decoded;
    }

    private static function secret(): string
    {
        return Config::get('JWT_SECRET');
    }
}
