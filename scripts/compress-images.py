import os
from PIL import Image

images_dir = os.path.join(os.path.dirname(__file__), '../images')
max_width = 1600

print(f"Scanning images in {images_dir}...")

for filename in os.listdir(images_dir):
    if not filename.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
        continue
        
    filepath = os.path.join(images_dir, filename)
    orig_size = os.path.getsize(filepath)
    
    # Only compress if larger than 500KB
    if orig_size < 500 * 1024:
        continue
        
    print(f"Compressing {filename} (Original size: {orig_size / 1024 / 1024:.2f} MB)...")
    
    try:
        with Image.open(filepath) as img:
            # Convert RGBA to RGB if saving as JPEG
            if img.mode in ('RGBA', 'LA') and filename.lower().endswith(('.jpg', '.jpeg')):
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3]) # 3 is alpha channel
                img = background
                
            width, height = img.size
            if width > max_width:
                ratio = max_width / float(width)
                new_height = int(float(height) * float(ratio))
                img = img.resize((max_width, new_height), Image.Resampling.LANCZOS)
                print(f"  Resized from {width}x{height} to {max_width}x{new_height}")
                
            img.save(filepath, optimize=True, quality=75)
            new_size = os.path.getsize(filepath)
            print(f"  Done! New size: {new_size / 1024 / 1024:.2f} MB (Reduced by {(1 - new_size/orig_size)*100:.1f}%)")
    except Exception as e:
        print(f"  Failed to compress {filename}: {e}")

print("Image compression scan finished!")
