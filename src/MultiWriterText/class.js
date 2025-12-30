export class MultiWriterText {
  constructor(writers, textSnapshot = undefined) {
    this.writers = writers;
    this.text = new Text(textSnapshot);
    collectGarbage(this.writers, this.text);
  }

  merge(contender) {
    this.text.merge(contender.text ?? contender);
    collectGarbage(this.writers, this.text);
  }

  snapshot() {
    return this.text.snapshot();
  }

  insert(operation) {
    this.text.insert(operation);
  }
  delete(operation) {
    this.text.delete(operation);
  }
  ack(operation) {
    this.text.ack(operation);
  }
}
