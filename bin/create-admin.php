<?php

declare(strict_types=1);

// Accounts are admin-created only, no self-registration (per README). This
// is that creation path -- run manually on the server, not exposed over
// HTTP (blocked by .htaccess along with the rest of bin/).

require __DIR__ . '/../vendor/autoload.php';

use Blanket\Auth\Password;
use Blanket\Repositories\UserRepository;

function prompt(string $label, bool $hidden = false): string
{
    fwrite(STDOUT, $label);
    if ($hidden) {
        system('stty -echo');
    }
    $value = trim((string) fgets(STDIN));
    if ($hidden) {
        system('stty echo');
        fwrite(STDOUT, "\n");
    }
    return $value;
}

$username = prompt('Username: ');
$email = prompt('Email: ');
$displayName = prompt('Display name: ');
$password = prompt('Password: ', hidden: true);
$isAdminInput = prompt('Grant admin? [y/N]: ');

if ($username === '' || $email === '' || $displayName === '' || $password === '') {
    fwrite(STDERR, "All fields are required.\n");
    exit(1);
}

$users = new UserRepository();
$id = $users->create(
    username: $username,
    email: $email,
    passwordHash: Password::hash($password),
    displayName: $displayName,
    isAdmin: strtolower($isAdminInput) === 'y',
);

fwrite(STDOUT, "Created user id {$id}.\n");
