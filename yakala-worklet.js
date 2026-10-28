// Mikrofon örneklerini ana iş parçacığına 20 ms'lik paketler halinde iletir.
class Yakala extends AudioWorkletProcessor {
  constructor() {
    super();
    this.boy = Math.round(sampleRate * 0.02);
    this.tampon = new Float32Array(this.boy);
    this.i = 0;
  }
  process(girdiler) {
    const kanal = girdiler[0] && girdiler[0][0];
    if (!kanal) return true;
    for (let k = 0; k < kanal.length; k++) {
      this.tampon[this.i++] = kanal[k];
      if (this.i === this.boy) {
        this.port.postMessage(this.tampon);
        this.tampon = new Float32Array(this.boy);
        this.i = 0;
      }
    }
    return true;
  }
}
registerProcessor('yakala', Yakala);
