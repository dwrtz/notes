/** workerd adds this to SubtleCrypto; the DOM lib typings do not. */
interface SubtleCrypto {
  timingSafeEqual(a: BufferSource, b: BufferSource): boolean;
}
