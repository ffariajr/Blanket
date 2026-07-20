<?php

declare(strict_types=1);

namespace Blanket\Auth;

final class CurrentUser
{
    public function __construct(
        public readonly int $id,
        public readonly string $username,
        public readonly string $displayName,
        public readonly bool $isAdmin,
    ) {
    }

    public static function anonymous(): self
    {
        return new self(id: 0, username: '__anonymous__', displayName: 'Anonymous', isAdmin: false);
    }

    public function isAnonymous(): bool
    {
        return $this->id === 0;
    }
}
