import p5 from '../../../src/app.js';
import { server } from '@vitest/browser/context'
import { THRESHOLD, DIFFERENCE, ERODE } from '../../../src/core/constants.js';
const { readFile, writeFile } = server.commands
import pixelmatch from 'pixelmatch';

// By how much can each color channel value (0-255) differ before
// we call it a mismatch? This should be large enough to not trigger
// based on antialiasing.
const COLOR_THRESHOLD = 25;

// The max side length to shrink test images down to before
// comparing, for performance.
const MAX_SIDE = 50;

// The background color to composite test cases onto before
// diffing. This is used because canvas DIFFERENCE blend mode
// does not handle alpha well. This should be a color that is
// unlikely to be in the images originally.
const BG = '#F0F';

function writeImageFile(filename, base64Data) {
  const prefix = /^data:image\/\w+;base64,/;
  writeFile(filename, base64Data.replace(prefix, ''), 'base64');
}

function toBase64(img) {
  return img.canvas.toDataURL();
}

function escapeName(name) {
  // Encode slashes as `encodeURIComponent('/')`
  return name.replace(/\//g, '%2F');
}

let namePrefix = '';

// By how many pixels can the snapshot shift? This is
// often useful to accommodate different text rendering
// across environments.
let shiftThreshold = 2;

/**
 * A helper to define a category of visual tests.
 *
 * @param name The name of the category of test.
 * @param callback A callback that calls `visualTest` a number of times to define
 * visual tests within this suite.
 * @param [options] An options object with optional additional settings. Set its
 * key `focus` to true to only run this test, or its `skip` key to skip it.
 */
export function visualSuite(
  name,
  callback,
  { focus = false, skip = false, shiftThreshold: newShiftThreshold } = {}
) {
  let suiteFn = describe;
  if (focus) {
    suiteFn = suiteFn.only;
  }
  if (skip) {
    suiteFn = suiteFn.skip;
  }
  suiteFn(name, () => {
    let lastShiftThreshold
    let lastPrefix;
    let lastDeviceRatio = window.devicePixelRatio;
    beforeAll(() => {
      lastPrefix = namePrefix;
      namePrefix += escapeName(name) + '/';
      lastShiftThreshold = shiftThreshold;
      if (newShiftThreshold !== undefined) {
        shiftThreshold = newShiftThreshold
      }

      // Force everything to be 1x
      window.devicePixelRatio = 1;
    })

    callback()

    afterAll(() => {
      namePrefix = lastPrefix;
      window.devicePixelRatio = lastDeviceRatio;
      shiftThreshold = lastShiftThreshold;
    });
  });
}

export async function checkMatch(actual, expected, p5) {
  let scale = Math.min(MAX_SIDE/expected.width, MAX_SIDE/expected.height);
  const ratio = expected.width / expected.height;
  const narrow = ratio !== 1;
  if (narrow) {
    scale *= 2;
  }
  
  for (const img of [actual, expected]) {
    img.resize(
      Math.ceil(img.width * scale),
      Math.ceil(img.height * scale)
    );
  }

  // Ensure both images have the same dimensions
  const width = expected.width;
  const height = expected.height;
  
  // Create canvases with background color
  const actualCanvas = p5.createGraphics(width, height);
  const expectedCanvas = p5.createGraphics(width, height);
  actualCanvas.pixelDensity(1);
  expectedCanvas.pixelDensity(1);
  
  actualCanvas.background(BG);
  expectedCanvas.background(BG);
  
  actualCanvas.image(actual, 0, 0);
  expectedCanvas.image(expected, 0, 0);
  
  // Load pixel data
  actualCanvas.loadPixels();
  expectedCanvas.loadPixels();
  
  // Create diff output canvas
  const diffCanvas = p5.createGraphics(width, height);
  diffCanvas.pixelDensity(1);
  diffCanvas.loadPixels();
  
  // Run pixelmatch
  const diffCount = pixelmatch(
    actualCanvas.pixels,
    expectedCanvas.pixels,
    diffCanvas.pixels,
    width,
    height,
    { 
      threshold: 0.6,
      includeAA: false,
      alpha: 0.1
    }
  );
  
  // If no differences, return early
  if (diffCount === 0) {
    actualCanvas.remove();
    expectedCanvas.remove();
    diffCanvas.updatePixels();
    return { ok: true, diff: diffCanvas };
  }
  
  // Post-process to identify and filter out isolated differences
  const visited = new Set();
  const clusterSizes = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pos = (y * width + x) * 4;
      
      // If this is a diff pixel (red in pixelmatch output) and not yet visited
      if (
        diffCanvas.pixels[pos] === 255 && 
        diffCanvas.pixels[pos + 1] === 0 && 
        diffCanvas.pixels[pos + 2] === 0 &&
        !visited.has(pos)
      ) {
        // Find the connected cluster size using BFS
        const clusterSize = findClusterSize(diffCanvas.pixels, x, y, width, height, 1, visited);
        clusterSizes.push(clusterSize);
      }
    }
  }
  
  // Define significance thresholds
  const MIN_CLUSTER_SIZE = 4;  // Minimum pixels in a significant cluster
  const MAX_TOTAL_DIFF_PIXELS = 40;  // Maximum total different pixels

  // Determine if the differences are significant
  const significantClusters = clusterSizes.filter(size => size >= MIN_CLUSTER_SIZE);
  const significantDiffPixels = significantClusters.reduce((sum, size) => sum + size, 0);

  // Update the diff canvas
  diffCanvas.updatePixels();
  
  // Clean up canvases
  actualCanvas.remove();
  expectedCanvas.remove();
  
  // Determine test result
  const ok = (
    diffCount === 0 ||  // No differences at all
    (
      significantDiffPixels === 0 ||  // No significant clusters
      (
        significantDiffPixels <= MAX_TOTAL_DIFF_PIXELS &&  // Total different pixels within tolerance
        significantClusters.length <= 2  // Not too many significant clusters
      )
    )
  );

  return { 
    ok,
    diff: diffCanvas,
    details: {
      totalDiffPixels: diffCount,
      significantDiffPixels,
      clusters: clusterSizes,
      significantClusters
    }
  };
}

/**
 * Find the size of a connected cluster of diff pixels using BFS
 */
function findClusterSize(pixels, startX, startY, width, height, radius, visited) {
  const queue = [{x: startX, y: startY}];
  let size = 0;
  
  while (queue.length > 0) {
    const {x, y} = queue.shift();
    const pos = (y * width + x) * 4;
    
    // Skip if already visited
    if (visited.has(pos)) continue;
    
    // Skip if not a diff pixel
    if (pixels[pos] !== 255 || pixels[pos + 1] !== 0 || pixels[pos + 2] !== 0) continue;
    
    // Mark as visited
    visited.add(pos);
    size++;
    
    // Add neighbors to queue
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        
        // Skip if out of bounds
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        
        // Skip if already visited
        const npos = (ny * width + nx) * 4;
        if (!visited.has(npos)) {
          queue.push({x: nx, y: ny});
        }
      }
    }
  }
  
  return size;
}

/**
 * A helper to define a visual test, where we will assert that a sketch matches
 * screenshots saved ahead of time of what the test should look like.
 *
 * When defining a new test, run the tests once to generate initial screenshots.
 *
 * To regenerate screenshots for a test, delete its screenshots folder in
 * the test/unit/visual/screenshots directory, and rerun the tests.
 *
 * @param testName The display name of a test. This also links the test to its
 * expected screenshot, so make sure to rename the screenshot folder after
 * renaming a test.
 * @param callback A callback to set up the test case. It takes two parameters:
 * first is `p5`, a reference to the p5 instance, and second is `screenshot`, a
 * function to grab a screenshot of the canvas. It returns either nothing, or a
 * Promise that resolves when all screenshots have been taken.
 * @param [options] An options object with optional additional settings. Set its
 * key `focus` to true to only run this test, or its `skip` key to skip it.
 */
export function visualTest(
  testName,
  callback,
  { focus = false, skip = false } = {}
) {
  let suiteFn = describe;
  if (focus) {
    suiteFn = suiteFn.only;
  }
  if (skip) {
    suiteFn = suiteFn.skip;
  }

  suiteFn(testName, function() {
    let name;
    let myp5;

    beforeAll(function() {
      name = namePrefix + escapeName(testName);
      return new Promise(res => {
        myp5 = new p5(function(p) {
          p.setup = function() {
            res();
          };
        });
      });
    });

    afterAll(function() {
      myp5.remove();
    });

    test('matches expected screenshots', async function() {
      let expectedScreenshots;
      try {
        const metadata = JSON.parse(await readFile(
          `../screenshots/${name}/metadata.json`
        ));
        expectedScreenshots = metadata.numScreenshots;
      } catch (e) {
        console.log(e);
        expectedScreenshots = 0;
      }

      const actual = [];

      // Generate screenshots
      await callback(myp5, () => {
        const img = myp5.get();
        img.pixelDensity(1);
        actual.push(img);
      });


      if (actual.length === 0) {
        throw new Error('No screenshots were generated. Check if your test generates screenshots correctly. If the test includes asynchronous operations, ensure they complete before the test ends.');
      }
      if (expectedScreenshots && actual.length !== expectedScreenshots) {
        throw new Error(
          `Expected ${expectedScreenshots} screenshot(s) but generated ${actual.length}`
        );
      }
      if (!expectedScreenshots) {
        await writeFile(
          `../screenshots/${name}/metadata.json`,
          JSON.stringify({ numScreenshots: actual.length }, null, 2)
        );
      }

      const expectedFilenames = actual.map(
        (_, i) => `../screenshots/${name}/${i.toString().padStart(3, '0')}.png`
      );
      const expected = expectedScreenshots
        ? (
          await Promise.all(
            expectedFilenames.map(path => myp5.loadImage('/unit/visual' + path.slice(2)))
          )
        )
        : [];

      for (let i = 0; i < actual.length; i++) {
        if (expected[i]) {
          const result = await checkMatch(actual[i], expected[i], myp5);
          if (!result.ok) {
            throw new Error(
              `Screenshots do not match! Expected:\n${toBase64(expected[i])}\n\nReceived:\n${toBase64(actual[i])}\n\nDiff:\n${toBase64(result.diff)}\n\n` +
              'If this is unexpected, paste these URLs into your browser to inspect them.\n\n' +
              `If this change is expected, please delete the screenshots/${name} folder and run tests again to generate a new screenshot.`,
            );
          }
        } else {
          writeImageFile(expectedFilenames[i], toBase64(actual[i]));
        }
      }
    });
  });
}
