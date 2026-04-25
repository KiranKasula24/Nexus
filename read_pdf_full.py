import pypdf
import os
import sys

# Set stdout to utf-8
sys.stdout.reconfigure(encoding='utf-8')

pdf_path = r'C:\Projects\nexus\nexus_MU.pdf'
with open(pdf_path, 'rb') as f:
    reader = pypdf.PdfReader(f)
    for i, page in enumerate(reader.pages):
        # Only process pages after page 5 if needed, but let's read the whole thing and filter in PS
        print(f'--- Page {i+1} ---')
        print(page.extract_text())
