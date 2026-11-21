class VaultError(Exception):
    pass


class InvalidRequest(VaultError):
    pass


class Forbidden(VaultError):
    pass


class InvalidKey(Forbidden):
    pass


class WrongScope(Forbidden):
    pass


class UseHandoff(VaultError):
    pass


class OriginMismatch(VaultError):
    pass


class NotFound(VaultError):
    pass


class SessionRequired(VaultError):
    pass


class VaultBusy(VaultError):
    pass


class VaultDamaged(VaultError):
    pass
