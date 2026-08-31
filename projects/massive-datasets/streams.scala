/*
 *
 * Name: vaughn mcmanamna
 * StudentID: v00987158
 *
 */

package streams

import scala.collection.mutable.{BitSet => MutableBitSet}
import scala.collection.BitSet
import org.apache.spark.rdd.RDD
import org.apache.spark.broadcast.Broadcast

/**
 * Spark RDD-based implementations of stream algorithms:
 * - Bloom Filter for membership testing
 * - Flajolet-Martin for cardinality estimation
 * - Reservoir Sampling for random sampling
 */

object BloomFilter {

  /**
   * Calculate the optimal number of bits for a Bloom filter
   *
   * Use the formula: m = n * ln(p) / ln(1 / (e^(ln(2)^2)))
   * where n = number of items, p = false positive rate
   *
   * Important: Use utils.truncate to truncate to 7 digits before ceiling
   */
  def calculateBitsToUse(nItems: Int, falsePositiveRate: Double): Int = {
    val top    = nItems * math.log(falsePositiveRate)
    val bottom = math.log(1.0 / math.exp(math.log(2) * math.log(2)))
    math.ceil(utils.truncate(top / bottom, 7)).toInt
  }

  /**
   * Calculate the optimal number of hash functions
   *
   * Use the formula: k = ceil(m/n * ln(2))
   * where m = bits, n = items
   */
  def calculateK(bitsToUse: Int, nItems: Int): Int =
    math.ceil((bitsToUse.toDouble / nItems) * math.log(2)).toInt

  /**
   * Create a Bloom filter from an RDD of strings
   * Uses parallel processing to build partial BitSets per partition,
   * then aggregates them with bitwise OR
   */
  def create(
    lines: RDD[String],
    falsePositiveRate: Double,
    hashes: List[Hash_Function]
  ): Filter = {

    // Count items in the RDD
    val nItemsInFilter = lines.count().toInt

    // Calculate optimal parameters
    val bitsToUse = calculateBitsToUse(nItemsInFilter, falsePositiveRate)
    val k = calculateK(bitsToUse, nItemsInFilter)

    // Create hash functions that map to [0, bitsToUse)
    val hashFunctions = hashes.take(k).map { f =>
      (v: String) => f(v) % bitsToUse
    }

    // Build the filter using aggregate:
    // - Each partition creates a local mutable BitSet
    // - Combine partitions with union
    // Note: hashFunctions and bitsToUse are small, no need to broadcast
    val bloomFilter: BitSet = lines.aggregate(MutableBitSet())(
      // seqOp: add all hash values for each string to the local BitSet
      (bitset, str) => {
        hashFunctions.foreach(f => bitset += f(str))
        bitset
      },
      // combOp: union two BitSets from different partitions
      (bs1, bs2) => {
        bs1 |= bs2
        bs1
      }
    ).toImmutable

    Filter(nItemsInFilter, bitsToUse, k, bloomFilter)
  }

  /**
   * Check if a value is possibly in the filter
   * Returns true if the value might be in the set (could be false positive)
   * Returns false if the value is definitely not in the set
   */
  def contains(params: Filter, value: String, hashes: List[Hash_Function]): Boolean =
    hashes.take(params.nHashes).forall(f => params.filter(f(value).abs % params.nBits))

  /**
   * Filter an RDD to find elements NOT in the Bloom filter
   * Broadcasts the filter parameters for efficient distributed processing
   */
  def filterNotIn(
    params: Filter,
    testLines: RDD[String],
    hashes: List[Hash_Function]
  ): RDD[String] = {

    val sc = testLines.sparkContext

    // Only broadcast the potentially large Bloom filter bitset
    val broadcastFilter = sc.broadcast(params.filter)

    // Small immutable values: keep in closure
    // no need to broadcast them
    val nBits   = params.nBits
    val hashFns = hashes.take(params.nHashes)

    testLines.filter { value =>
      val filterBits = broadcastFilter.value

      // Return true if definitely NOT in filter, false otherwise
      !hashFns.forall(f => filterBits(f(value).abs % nBits))
    }
  }

}

object FlajoletMartin {

  /**
   * Count trailing zeros in binary representation
   * Returns the number of trailing zeros up to maxBit
   */
  def countZeroes(v: Int, maxBit: Int): Int = {
    def loop(n: Int, count: Int): Int =
      if (count >= maxBit || (n & 1) == 1) count
      else loop(n >> 1, count + 1)
    loop(v, 0)
  }

  /**
   * Hash a string and count trailing zeros (provided)
   */
  def hashStringToZeroesCount(st: String, bitsPerHash: Int, f: Hash_Function): Int = {
    countZeroes(f(st), bitsPerHash)
  }

  /**
   * Element-wise maximum of two lists
   */
  def maxEach(a: List[Int], b: List[Int]): List[Int] =
    a.zip(b).map { case (x, y) => math.max(x, y) }

  /**
   * Compute median of an array (provided)
   */
  def median(ar: Array[Int]): Double = {
    val a = ar.sorted
    val l = a.size
    val mid = a.size / 2
    if (l % 2 == 1) {
      a(mid)
    } else {
      (a(mid).toDouble + a(mid - 1).toDouble) / 2
    }
  }

  /**
   * Compute 2^i (provided)
   */
  def exp2(i: Int): Int = {
    1 << i
  }

  /**
   * Compute average of a list (provided)
   */
  def average(a: List[Double]): Double = {
    a.sum / a.size
  }

  /**
   * Estimate cardinality of distinct elements in an RDD using Flajolet-Martin algorithm
   *
   * Process:
   * 1. For each element, compute hash values and count trailing zeros
   * 2. For each hash function, find the maximum trailing zeros across all elements
   * 3. Convert to powers of 2
   */
  def estimate(
    lines: RDD[String],
    bits: Int,
    hashes: List[Hash_Function]
  ): FM_Result = {

    // No broadcasting needed for parameters since they are small

    val hashCounts: List[Int] =
      lines
        .map(str => hashes.map(f => hashStringToZeroesCount(str, bits, f)))
        .reduce(maxEach)
        .map(exp2)

    FM_Result(hashCounts, hashes.size)
  }

  /**
   * Summarize hash counts using median-of-averages approach
   * Groups hash counts, computes median of each group, then averages the medians
   */
  def summarize(hashCounts: List[Int], groupSize: Int): Double =
    average(hashCounts.grouped(groupSize).toList.map(g => median(g.toArray)))
}

object ReservoirSample {

  /**
   * Process a stream with standing queries using reservoir sampling
   * Note: This collects data locally, it is not an algorithm
   * that benefits from distribution due to the way sampling works
   * The iterator allows processing elements as they arrive
   */
  def processWithQueries(
    data: Iterator[Int],
    sizeSample: Int,
    r: scala.util.Random,
    queries: List[Standing_Query]
  ): Unit = {

    require(sizeSample > 0, "Sample size must be positive")

    // Build initial reservoir
    val initial = data.take(sizeSample).toVector
    val initialSize = initial.size

    queries.foreach(q => q(initial, initialSize))

    if (initialSize < sizeSample)
      return ()

    // Process remaining elements using foldLeft
    // The accumulator is a tuple: (currentSample: Vector[Int], count: Int)
    data.foldLeft((initial, sizeSample)) {
      case ((sample, count), elem) =>
        val n = count + 1
        if (r.nextDouble() < sizeSample.toDouble / n) {
          val updated = sample.updated(r.nextInt(sizeSample), elem)
          queries.foreach(q => q(updated, n))
          (updated, n)
        } else {
          (sample, n)
        }
    }
    // return a Unit
    ()
  }
}
