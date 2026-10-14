/** Return the mean amplitude of a signal. */
function average(samples: number[]): number {
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

const samples = [0.2, 0.8, -0.4, 0.5, 1.0];
const amplitude: number = "high";
console.log(average(samples), amplitude);
