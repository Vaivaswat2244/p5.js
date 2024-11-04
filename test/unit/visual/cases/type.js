import { visualSuite, visualTest } from '../visualTest';

visualSuite('type', function () {
  visualSuite('v1', function () {
    visualSuite('textFont', function () {
      visualTest('with the default font', function (p5, screenshot) {
        p5.createCanvas(50, 50);
        p5.textSize(20);
        p5.textAlign(p5.LEFT, p5.TOP);
        p5.text('test', 0, 0);
        screenshot();
      });

      visualTest('with the default monospace font', function (p5, screenshot) {
        p5.createCanvas(50, 50);
        p5.textSize(20);
        p5.textFont('monospace');
        p5.textAlign(p5.LEFT, p5.TOP);
        p5.text('test', 0, 0);
        screenshot();
      });
    });
  });
});