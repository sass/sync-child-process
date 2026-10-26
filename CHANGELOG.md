## 1.1.1

* Fix a bug where large chunks of data emitted at once in `stdout` or `stderr`
  could become corrupted.

## 1.1.0

* Fix a bug where `ChildProcess` would hang when writing to the stdin of a
  process that has already exited. Instead, it now throws an `EPIPE` error the
  next time `next()` is called.

## 1.0.2

* No user-visible changes

## 1.0.1

* No user-visible changes

## 1.0.0

* Initial release
