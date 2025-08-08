# shade

Node-based GPU-accelerated image processing and color grading tool

```
Options:
  -e, --example <FILE>          Output image file
  -i, --input <FILE>            Input image file
  -o, --output <FILE>           Output image file
  -b, --brightness <VALUE>      Adjust brightness (-1.0 to 1.0, 0.0 = no change)
  -c, --contrast <VALUE>        Adjust contrast (0.0 to 2.0, 1.0 = no change)
  -s, --saturation <VALUE>      Adjust saturation (0.0 to 2.0, 1.0 = no change)
  -u, --hue <DEGREES>           Adjust hue (-180.0 to 180.0 degrees, 0.0 = no change)
  -g, --gamma <VALUE>           Adjust gamma (0.1 to 3.0, 1.0 = no change)
      --blur <RADIUS>           Apply blur filter (radius in pixels)
      --sharpen <AMOUNT>        Apply sharpen filter (0.0 to 2.0)
      --noise <AMOUNT>          Add noise (0.0 to 1.0)
      --scale <FACTOR>          Scale image (0.1 to 5.0)
      --rotate <DEGREES>        Rotate image (degrees)
      --auto-white-balance      Automatically adjust white balance
      --wb-temperature <VALUE>  Manual white balance temperature (-1.0 to 1.0, 0.0 = no change)
      --wb-tint <VALUE>         Manual white balance tint (-1.0 to 1.0, 0.0 = no change)
  -v, --verbose                 Enable verbose output
  -h, --help                    Print help
  -V, --version                 Print version

EXAMPLES:
    Basic image processing:
      shade -i input.jpg -o output.jpg --brightness 0.2 --contrast 1.1
      shade -i photo.png -o enhanced.png --saturation 1.3 --sharpen 0.8
      shade -i image.jpg -o blurred.jpg --blur 2.5
      shade -i portrait.jpg -o corrected.jpg --auto-white-balance
      shade -i sunset.jpg -o warmer.jpg --wb-temperature 0.3 --wb-tint -0.1

    Complex processing:
      shade -i original.png -o processed.png -b 0.1 -c 1.2 -s 1.1 --gamma 0.9

    OpenEXR HDR processing:
      shade -i input.exr -o output.exr --brightness 0.5  # Process HDR files
      shade -i hdr.exr -o display.png --gamma 2.2

    High quality processing:
      shade --example mandelbrot.raw  # 32-bit float data
      shade -i input.jpg -o output.png  # Automatic format detection
```
